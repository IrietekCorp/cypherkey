import { useCallback, useEffect, useMemo, useState } from 'react';
import { scriptsEqual } from '../../../core/biometrics/script';
import { createEnroller } from '../../../core/client/enroll';
import type { Session } from '../../../core/client/session';
import { RhythmLight } from '../../src/components/RhythmLight';
import { preventFocusSteal, useCapture } from '../../src/components/useCapture';

/**
 * The message for a sample that was not the enrolled script.
 *
 * "Backspace retry" is withdrawn: Backspace is a legitimate Phantom Key, so a sample
 * containing one is not an error. The only retry condition is a **script mismatch**.
 */
export const MISMATCH_MESSAGE =
  'That was a different sequence of keys. Type it exactly as you did when you chose it, including any Backspace, Delete or Escape.';

/** Server rejections that mean "same idea, different keys". */
const MISMATCH_ERRORS = new Set([
  'script_mismatch',
  'script_length_mismatch',
  'commitment_length_mismatch',
]);

export type EnrollProps = {
  session: Pick<Session, 'authed' | 'commitmentsFor'>;
  enrollmentToken: string;
  /**
   * The script chosen at onboarding, when it is still known. It is deliberately never
   * persisted, so a popup reopened mid-enrolment will not have it — the screen then
   * lets the server be the judge instead of guessing.
   */
  script?: string;
  onBuilt(result: { scriptLen: number; sampleCount: number }): void;
};

type Progress = { required: number; submitted: number; remaining: number; built: boolean };

export function Enroll({ session, enrollmentToken, script, onBuilt }: EnrollProps) {
  const capture = useCapture();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [buildButton, setBuildButton] = useState<HTMLButtonElement | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const [light, setLight] = useState<HTMLDivElement | null>(null);

  // Memoized: a fresh enroller on every render would change `refresh`'s identity,
  // which would refire the effect below, which sets state -- an infinite loop that
  // shows up as a blank screen rather than an error.
  const enroller = useMemo(
    () => createEnroller({ request: session.authed(), token: enrollmentToken }),
    [session, enrollmentToken],
  );

  /**
   * Progress comes from the server, not a local counter. A popup that closes mid-way
   * must resume where the account actually is, and a local count would either restart
   * at zero or claim samples the server never received.
   */
  const refresh = useCallback(async () => {
    setProgress(await enroller.status());
  }, [enroller]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const begin = () => {
    if (input !== null && light !== null) {
      setMessage(null);
      capture.start(input, light);
    }
  };

  const armNext = () => capture.reset();

  const submitted = progress?.submitted ?? 0;
  const required = progress?.required ?? 0;
  const complete = progress !== null && progress.remaining === 0 && !progress.built;

  /**
   * Arms the next sample once the field can take one.
   *
   * Enrolment asks for the same passphrase eight times, and capture is armed by
   * `onFocus` -- but neither way of submitting moves focus, so nothing re-armed and
   * every sample after the first went nowhere: the light sat at Idle and the count
   * never moved. Re-arming inside `submit` did not work either, because the field is
   * `disabled` while the sample is in flight, and disabling it takes the focus away.
   *
   * So it is done here, when `busy` clears and the input is interactive again. Only
   * from `idle`, so this never restarts a capture already in progress, and never while
   * the screen is complete.
   */
  useEffect(() => {
    if (busy || complete || input === null || light === null) return;
    if (capture.state.status !== 'idle') return;
    input.focus();
    capture.start(input, light);
  }, [busy, complete, input, light, capture.state.status, capture.start]);

  /**
   * When the eighth sample lands, focus moves to the button that finishes.
   *
   * The passphrase field is disabled once the count is complete, so Enter there does
   * nothing and the screen appears to stop responding to a key it accepted eight times
   * in a row. Moving focus keeps the whole flow on the keyboard, and Enter activates a
   * focused button without any handler of ours.
   */
  useEffect(() => {
    if (complete && !busy && buildButton !== null) buildButton.focus();
  }, [complete, busy, buildButton]);

  const submit = async () => {
    const sample = capture.stop();
    if (sample === null) return; // the hook is already saying why
    if (input !== null) input.value = '';

    // When the script is known, catch a mismatch here rather than spending a round
    // trip on it. `scriptsEqual` is constant-time.
    if (script !== undefined && !scriptsEqual(script, sample.script)) {
      setMessage(MISMATCH_MESSAGE);
      armNext();
      return;
    }

    setBusy(true);
    try {
      const commitments = await session.commitmentsFor(sample.script);
      await enroller.sample({ featureVector: sample.featureVector, commitments });
      await refresh();
      armNext();
    } catch (err) {
      const reason = (err as Error).message;
      setMessage(MISMATCH_ERRORS.has(reason) ? MISMATCH_MESSAGE : reason);
      armNext();
    } finally {
      setBusy(false);
    }
  };

  const build = async () => {
    setBusy(true);
    try {
      const result = await enroller.build();
      onBuilt({ scriptLen: result.scriptLen, sampleCount: result.sampleCount });
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="ck-app flex flex-col" style={{ padding: 'var(--ck-s5)', gap: 'var(--ck-s4)' }}>
      {/* Frame 05. */}
      <header className="flex items-baseline justify-between" style={{ gap: 'var(--ck-s3)' }}>
        <span className="ck-wordmark ck-small ck-muted">CypherKey</span>
        <span data-testid="step" className="ck-small ck-muted ck-num">
          Sample {Math.min(submitted + 1, Math.max(required, 1))} of {required}
        </span>
      </header>

      <div className="flex flex-col" style={{ gap: 'var(--ck-s1)' }}>
        <h1 className="ck-h1">Teach it your rhythm</h1>
        <p className="ck-small ck-muted">
          {/*
            Deliberately NOT "type it fast once and slow once". Measured during M2-00g:
            six natural samples plus one slow and one fast raised the median feature
            spread from 8 ms to 21 ms and lifted a stranger from a clear fail to a
            comfortable pass. A wider band cannot tell anyone apart; it just admits more
            people. Real variation is learned from real logins.
          */}
          Type your passphrase the way you normally would. Don't try to be consistent — just be
          yourself.
        </p>
      </div>

      {/*
        Progress, not a score. How many samples are in is a fact the user can act on;
        how well any of them scored is the one signal an attacker could iterate against.
      */}
      <div
        data-testid="ring"
        data-submitted={submitted}
        data-required={required}
        className="flex items-center"
        style={{ gap: 'var(--ck-s3)' }}
      >
        <div
          className="flex-1 overflow-hidden"
          style={{ height: 4, borderRadius: 2, background: 'var(--ck-inset)' }}
        >
          <div
            className="h-full transition-all"
            style={{
              width: required === 0 ? '0%' : `${(submitted / required) * 100}%`,
              background: 'var(--ck-accent)',
              borderRadius: 2,
            }}
          />
        </div>
        <span className="ck-small ck-muted ck-num">
          {submitted} of {required}
        </span>
      </div>

      <label className="field">
        <span>{submitted === 0 ? 'Passphrase' : 'Type your passphrase again'}</span>
        <input
          ref={setInput}
          type="password"
          data-testid="passphrase"
          onFocus={begin}
          /*
            Eight samples in a row is the one screen where reaching for the mouse between
            each is worst: it breaks the rhythm being measured. Enter ends a sample without
            the pointer leaving the field, and A-14.1 treats it as a terminator that
            produces no token, so it tokenizes identically to a click.
          */
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || busy || complete) return;
            e.preventDefault();
            void submit();
          }}
          disabled={complete || busy}
          className="input"
        />
      </label>

      {/* X-1: on screen at every stage. Capture refuses to run without it. */}
      <RhythmLight ref={setLight} state={capture.state} />

      {message !== null && (
        <p data-testid="message" className="ck-small" style={{ color: 'var(--ck-fail-text)' }}>
          {message}
        </p>
      )}

      {complete ? (
        <div className="flex flex-col" style={{ gap: 'var(--ck-s3)' }}>
          <p className="ck-small ck-muted">
            {/* A-4.6: the samples are deleted once the profile is built. Worth saying. */}
            When the profile is built your samples are deleted. What is left is a set of timing
            ranges — your passphrase is not in it.
          </p>
          <button
            ref={setBuildButton}
            type="button"
            data-testid="build"
            disabled={busy}
            onClick={build}
            className="btn btn-primary btn-block"
          >
            Build my profile
          </button>
        </div>
      ) : (
        <button
          type="button"
          data-testid="submit"
          disabled={busy}
          onMouseDown={preventFocusSteal}
          onClick={submit}
          className="btn btn-primary btn-block"
        >
          Record this one
        </button>
      )}
    </main>
  );
}
