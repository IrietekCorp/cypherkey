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
    <main className="flex flex-col gap-3 p-4 font-sans text-sm">
      <h1 className="text-base font-semibold">Teach it your rhythm</h1>
      <p className="text-xs text-neutral-600">
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

      <div
        data-testid="ring"
        data-submitted={submitted}
        data-required={required}
        className="flex items-center gap-2"
      >
        <div className="h-2 flex-1 overflow-hidden rounded bg-neutral-200">
          <div
            className="h-full bg-neutral-900 transition-all"
            style={{ width: required === 0 ? '0%' : `${(submitted / required) * 100}%` }}
          />
        </div>
        <span className="text-xs text-neutral-600">
          {submitted} of {required}
        </span>
      </div>

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
        className="rounded border border-neutral-300 px-2 py-1"
      />

      <RhythmLight ref={setLight} state={capture.state} />

      {message !== null && (
        <p data-testid="message" className="text-xs text-rose-700">
          {message}
        </p>
      )}

      {complete ? (
        <>
          <p className="text-xs text-neutral-600">
            {/* A-4.6: the samples are deleted once the profile is built. Worth saying. */}
            Your samples are turned into a profile and then deleted — the individual recordings are
            not kept.
          </p>
          <button
            type="button"
            data-testid="build"
            disabled={busy}
            onClick={build}
            className="rounded bg-neutral-900 px-2 py-1 text-white disabled:opacity-40"
          >
            Build my profile
          </button>
        </>
      ) : (
        <button
          type="button"
          data-testid="submit"
          disabled={busy}
          onMouseDown={preventFocusSteal}
          onClick={submit}
          className="rounded bg-neutral-900 px-2 py-1 text-white disabled:opacity-40"
        >
          Record this one
        </button>
      )}
    </main>
  );
}
