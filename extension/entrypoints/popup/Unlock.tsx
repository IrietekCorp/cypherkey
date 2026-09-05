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
  onUnlocked(): void;
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
      capture.start(input, light);
    }
  };

  const clear = () => {
    if (input !== null) input.value = '';
    capture.reset();
  };

  const applyResult = (result: LoginResult) => {
    if (result.band === 'pass') {
      onUnlocked();
      return;
    }
    if (result.band === 'grey') {
      // X-3: the grey band asks for a second sample and scores the average. The user
      // is not being refused, so the copy must not read like a refusal.
      setStage('grey');
      setMessage(GREY_MESSAGE);
      return;
    }
    if (result.error === 'locked_out') {
      setLocked(true);
      setMessage(LOCKED_MESSAGE);
      return;
    }
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
        if (ok) onUnlocked();
        else {
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

  return (
    <main className="flex flex-col gap-3 p-4 font-sans text-sm">
      <h1 className="text-base font-semibold">Unlock CypherKey</h1>
      {offline && (
        <p data-testid="offline" className="text-xs text-neutral-600">
          You are offline. This device can still open its cached vault.
        </p>
      )}

      <input
        ref={setInput}
        type="password"
        data-testid="passphrase"
        onFocus={begin}
        disabled={busy || locked || stage === 'step-up'}
        className="rounded border border-neutral-300 px-2 py-1"
      />

      <RhythmLight ref={setLight} state={capture.state} />

      {message !== null && (
        <p
          data-testid="message"
          className={stage === 'grey' ? 'text-xs text-amber-700' : 'text-xs text-rose-700'}
        >
          {message}
        </p>
      )}

      {failures >= WARN_AFTER && !locked && (
        <p data-testid="lockout-warning" className="text-xs text-neutral-600">
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
          className="rounded bg-neutral-900 px-2 py-1 text-white disabled:opacity-40"
        >
          {stage === 'grey' ? 'Type it once more' : 'Unlock'}
        </button>
      )}

      {(stage === 'step-up' || locked) && (
        <div data-testid="step-up" className="flex flex-col gap-2">
          <p className="text-xs text-neutral-700">
            {/*
              Backup Codes, never "recovery codes". A Backup Code opens a session; the
              Recovery Kit opens a vault, and is deliberately not offered here.
            */}
            Enter one of your Backup Codes to get in.
          </p>
          <input
            ref={setCodeField}
            data-testid="backup-code"
            placeholder="XXXXX-XXXXX"
            className="rounded border border-neutral-300 px-2 py-1 font-mono"
          />
          <button
            type="button"
            data-testid="use-backup-code"
            disabled={busy}
            onClick={useBackupCode}
            className="rounded bg-neutral-900 px-2 py-1 text-white disabled:opacity-40"
          >
            Use Backup Code
          </button>
        </div>
      )}

      <button
        type="button"
        data-testid="forgot"
        onClick={onForgotPassphrase}
        className="self-start text-xs text-neutral-500 underline"
      >
        I've forgotten my passphrase
      </button>
    </main>
  );
}
