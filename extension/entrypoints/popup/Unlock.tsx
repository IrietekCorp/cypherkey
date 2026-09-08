import { useState } from 'react';
import type { Credential, LoginResult, Session } from '../../../core/client/session';
import { RhythmLight } from '../../src/components/RhythmLight';
import { preventFocusSteal, useCapture } from '../../src/components/useCapture';

/** X-3's ladder, in the words the user reads. */
export const GREY_MESSAGE = 'Your rhythm looks different today. Type it once more.';
export const FAIL_MESSAGE = "That didn't match your rhythm.";
export const LOCKED_MESSAGE =
  'Too many failed attempts. This account is locked for a short while. Wait, or use a Backup Code.';

/**
 * Shown before the lock, not after.
 *
 * The server does not report how many attempts remain — it answers 401 either way —
 * so this counts what this screen has seen and warns rather than claiming a precise
 * number it cannot know. An exact count would be a lie whenever a second device or an
 * earlier session has already spent some of the budget.
 */
export const LOCKOUT_WARNING =
  'Repeated failures will lock this account for 15 minutes. A Backup Code will still get you in.';

/** How many failures this screen has seen before it warns. */
const WARN_AFTER = 2;

export type UnlockProps = {
  session: Pick<
    Session,
    'login' | 'stepUp' | 'unlockOffline' | 'state' | 'recover' | 'commitmentsFor'
  >;
  username: string;
  strictness: Credential['strictness'];
  /** True when the network is unreachable; drives the A-7 offline path. */
  offline?: boolean;
  /** The account's current key version, which the cache uses to detect a re-key. */
  /**
   * `enrollment` is present when the login found the account unenrolled: the token that
   * lets the caller finish what a closed popup interrupted. The vault is not worth
   * opening in that state -- there is no profile, so nothing has ever been protected by
   * a rhythm check.
   */
  onUnlocked(keyVersion: number, enrollment?: { token?: string }): void;
  onForgotPassphrase(): void;
};

type Stage = 'entry' | 'grey' | 'step-up';

export function Unlock({
  session,
  username,
  strictness,
  offline = false,
  onUnlocked,
  onForgotPassphrase,
}: UnlockProps) {
  const capture = useCapture();
  const [stage, setStage] = useState<Stage>('entry');
  const [message, setMessage] = useState<string | null>(null);
  const [failures, setFailures] = useState(0);
  /**
   * The band of the last attempt, for the light and the header.
   *
   * The board also shows a score -- "Amber band · 0.53" -- which the server does not
   * send: grey answers `{band, stepUp}` and fail `{band, error}`. It is not invented
   * here. Surfacing one is a server change and worth a moment's thought first, because a
   * live score is exactly the feedback an attacker needs to hill-climb toward a profile.
   */
  const [band, setBand] = useState<'pass' | 'grey' | 'fail' | null>(null);
  const [failCode, setFailCode] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  // Uncontrolled, like the identity fields in M2-03: React's onChange does not fire
  // under happy-dom, so a controlled value here would be untestable and buys nothing.
  const [codeField, setCodeField] = useState<HTMLInputElement | null>(null);
  const [light, setLight] = useState<HTMLDivElement | null>(null);

  const begin = () => {
    if (input !== null && light !== null) {
      setMessage(null);
      setBand(null);
      capture.start(input, light);
    }
  };

  const clear = () => {
    if (input !== null) input.value = '';
    capture.reset();
  };

  const applyResult = (result: LoginResult) => {
    if (result.band === 'pass') {
      onUnlocked(
        result.keyVersion,
        result.enrolled === false
          ? { ...(result.enrollmentToken === undefined ? {} : { token: result.enrollmentToken }) }
          : undefined,
      );
      return;
    }
    if (result.band === 'grey') {
      // X-3: the grey band asks for a second sample and scores the average. The user
      // is not being refused, so the copy must not read like a refusal.
      setBand('grey');
      setStage('grey');
      setMessage(GREY_MESSAGE);
      return;
    }
    if (result.error === 'locked_out') {
      setLocked(true);
      setMessage(LOCKED_MESSAGE);
      return;
    }
    setBand('fail');
    setFailCode(result.error);
    setFailures((n) => n + 1);
    // A failed grey retype has nowhere left to go on rhythm alone, so offer the factor
    // that does not depend on it.
    setStage((current) => (current === 'grey' ? 'step-up' : 'entry'));
    setMessage(FAIL_MESSAGE);
  };

  const submit = async () => {
    const sample = capture.stop();
    if (sample === null) return; // the hook is already saying why
    const credential: Credential = {
      resolved: sample.resolved,
      script: sample.script,
      strictness,
    };
    clear();

    setBusy(true);
    try {
      if (offline) {
        // A-7: a device that has unlocked online before can unlock from its cached
        // blob. There is no scoring here — the server is not reachable to do it.
        const ok = await session.unlockOffline(credential);
        // Offline there is no server to report a key version, so the cache keeps
        // whatever it already believes. A re-key elsewhere is detected on the next
        // online unlock, which is the earliest it can be known.
        if (ok) onUnlocked(0);
        else {
          // No band here: nothing was scored. The cached vault simply did not open, and
          // saying "that didn't match your rhythm" would name the wrong cause.
          setFailures((n) => n + 1);
          setMessage('That passphrase did not open the offline vault on this device.');
        }
        return;
      }

      applyResult(
        stage === 'grey'
          ? await session.stepUp({
              method: 'retype',
              script: sample.script,
              featureVector: sample.featureVector,
            })
          : await session.login({
              ...credential,
              username,
              featureVector: sample.featureVector,
            }),
      );
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const useBackupCode = async () => {
    setBusy(true);
    try {
      applyResult(await session.stepUp({ method: 'backup_code', proof: codeField?.value ?? '' }));
      if (codeField !== null) codeField.value = '';
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /*
    Frames 06-08 of Design Pass v2.

    One screen, three faces: entry, amber and refused. The heading and the tag carry the
    outcome so the light is not the only thing saying it -- the guide is explicit that
    amber gets a line and a dot and nothing that amplifies it, so there is no filled
    panel, no icon and no exclamation anywhere below.
  */
  const heading =
    band === 'grey'
      ? 'Looks a little different'
      : band === 'fail'
        ? "That didn't match your rhythm"
        : 'Welcome back';

  return (
    <main className="ck-app flex flex-col" style={{ padding: 'var(--ck-s5)', gap: 'var(--ck-s5)' }}>
      <header className="flex items-center" style={{ gap: 'var(--ck-s2)' }}>
        <span className="ck-wordmark ck-small ck-muted">CypherKey</span>
      </header>

      <div className="flex flex-col" style={{ gap: 'var(--ck-s1)' }}>
        <div className="flex items-baseline flex-wrap" style={{ gap: 'var(--ck-s2)' }}>
          <h1 className="ck-h1">{heading}</h1>
          {band === 'grey' && (
            <span data-testid="band" className="tag tag-amber">
              Amber band
            </span>
          )}
          {band === 'fail' && (
            <span data-testid="band" className="tag tag-fail">
              {failCode === null ? 'Fail' : `Fail · ${failCode}`}
            </span>
          )}
        </div>
        <p className="ck-small ck-muted">
          {band === null ? 'Type your passphrase the way you always type it.' : null}
        </p>
      </div>

      {offline && (
        <p data-testid="offline" className="ck-small ck-muted">
          You are offline. This device can still open its cached vault.
        </p>
      )}

      {/*
        X-1: the light is never hidden to tidy a layout. Capture stops entirely if it is,
        so it stays on screen through every stage of this component.
      */}
      <RhythmLight ref={setLight} state={capture.state} {...(band === null ? {} : { band })} />

      <label className="field">
        <span>Passphrase</span>
        <input
          ref={setInput}
          type="password"
          data-testid="passphrase"
          onFocus={begin}
          /*
            Unlocking is the interaction this product asks for every day, and it is the one
            where reaching for the mouse is worst: the click has to be preceded by a
            `preventFocusSteal` to avoid blurring the sample it is submitting. Enter ends
            the sample without focus moving at all, and A-14.1 treats it as a terminator
            that produces no token.
          */
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || busy || locked || stage === 'step-up') return;
            e.preventDefault();
            void submit();
          }}
          disabled={busy || locked || stage === 'step-up'}
          className="input"
        />
      </label>

      {message !== null && (
        <p
          data-testid="message"
          className="ck-small"
          style={{ color: stage === 'grey' ? 'var(--ck-amber-text)' : 'var(--ck-fail-text)' }}
        >
          {message}
        </p>
      )}

      {failures >= WARN_AFTER && !locked && (
        <p data-testid="lockout-warning" className="ck-small ck-muted">
          {LOCKOUT_WARNING}
        </p>
      )}

      {stage !== 'step-up' && (
        <button
          type="button"
          data-testid="submit"
          disabled={busy || locked}
          onMouseDown={preventFocusSteal}
          onClick={submit}
          className="btn btn-primary btn-block"
        >
          {stage === 'grey' ? 'Type it again' : 'Unlock'}
        </button>
      )}

      {(stage === 'step-up' || locked) && (
        <div data-testid="step-up" className="card flex flex-col" style={{ gap: 'var(--ck-s3)' }}>
          <p className="ck-small ck-muted">
            {/*
              Backup Codes, never "recovery codes". A Backup Code opens a session; the
              Recovery Kit opens a vault, and is deliberately not offered here.
            */}
            Enter one of your Backup Codes to get in. Each code works once.
          </p>
          <input
            ref={setCodeField}
            data-testid="backup-code"
            placeholder="XXXXX-XXXXX"
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || busy) return;
              e.preventDefault();
              void useBackupCode();
            }}
            className="input font-mono"
          />
          <button
            type="button"
            data-testid="use-backup-code"
            disabled={busy}
            onClick={useBackupCode}
            className="btn btn-primary btn-block"
          >
            Use code
          </button>
          {!locked && (
            <button
              type="button"
              data-testid="retry-typing"
              disabled={busy}
              onClick={() => {
                setStage('entry');
                setBand(null);
                setFailCode(null);
                setMessage(null);
                clear();
              }}
              className="btn btn-ghost ck-small"
            >
              Try typing again
            </button>
          )}
        </div>
      )}

      {/*
        The de-escalating line the guide asks for: amber is "probably still you", and the
        vault is never at risk in either direction.
      */}
      {stage === 'grey' && (
        <p className="ck-small ck-muted">
          One retype, then a Backup Code. Your vault stays where it is either way.
        </p>
      )}

      {/*
        Hidden during step-up, which is frame 08 and also a rule: the Recovery Kit opens
        a vault and re-keys the account, a Backup Code opens one session. Offering both
        at the moment someone is failing a rhythm check invites the destructive one.
      */}
      {stage !== 'step-up' && !locked && (
        <button
          type="button"
          data-testid="forgot"
          onClick={onForgotPassphrase}
          className="btn btn-ghost ck-small self-start"
        >
          Lost every device? Use your Recovery Kit
        </button>
      )}
    </main>
  );
}
