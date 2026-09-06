import { useEffect, useRef, useState } from 'react';
import { scriptLength, scriptsEqual } from '../../../core/biometrics/script';
import type { Session, SignupResult } from '../../../core/client/session';
import { RhythmLight } from '../../src/components/RhythmLight';
import { preventFocusSteal, useCapture } from '../../src/components/useCapture';
import { assessPassphrase, lengthProblems, warmStrength } from '../../src/passphrase-strength';

export type OnboardingProps = {
  session: Pick<Session, 'signup'>;
  /** A-12: recorded with the consent, so a policy change is auditable. */
  consentPolicyVersion: string;
  /**
   * `script` is handed on so enrolment can catch a mismatch without a round trip. It
   * lives in memory for the length of the flow and is never persisted — it is the key
   * sequence, and A-7 permits none of it on disk.
   */
  /**
   * `resolved` is handed on for the X-7 party trick, which has to show the passphrase
   * to a friend. In memory for the length of the flow only; A-7 permits none of it on
   * disk, and it is dropped as soon as the trick is done.
   */
  onComplete(result: SignupResult, script: string, username: string, resolved: string): void;
};

type Captured = { script: string; resolved: string };

/** X-2. The account's key hierarchy is decided here, and two inputs cannot change later. */
export function Onboarding({ session, consentPolicyVersion, onComplete }: OnboardingProps) {
  const input = useRef<HTMLInputElement>(null);
  const light = useRef<HTMLDivElement>(null);
  const capture = useCapture();

  // Uncontrolled on purpose. These are plain text fields with no formatting or
  // as-you-type validation, so controlled state buys nothing but re-renders during
  // typing — and typing is the one thing this screen must not stutter through.
  const username = useRef<HTMLInputElement>(null);
  const email = useRef<HTMLInputElement>(null);
  const [first, setFirst] = useState<Captured | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);

  // Load zxcvbn's dictionaries while the user is filling in their username, so the
  // first strength check does not wait on a ~2 MB import.
  useEffect(() => {
    void warmStrength();
  }, []);

  const begin = () => {
    if (input.current !== null && light.current !== null) {
      setProblems([]);
      capture.start(input.current, light.current);
    }
  };

  const clearField = () => {
    if (input.current !== null) input.current.value = '';
  };

  /** First pass: check strength, then ask for it again. */
  const takeFirst = async () => {
    const sample = capture.stop();
    if (sample === null) return; // the hook is already showing why
    const strength = await assessPassphrase(sample.resolved);
    if (!strength.acceptable) {
      setProblems([...strength.problems, ...strength.suggestions]);
      capture.reset();
      clearField();
      return;
    }
    setFirst({ script: sample.script, resolved: sample.resolved });
    capture.reset();
    clearField();
  };

  /**
   * Second pass. A-14: the two must be **token-identical**, not merely resolve to the
   * same text — otherwise the phantoms are not part of the credential at all. The
   * comparison is constant-time.
   */
  const takeSecond = async () => {
    const sample = capture.stop();
    if (sample === null || first === null) return;

    if (!scriptsEqual(first.script, sample.script)) {
      setProblems([
        'That was a different sequence of keys. Type it exactly as before, including any Backspace, Delete or Escape.',
      ]);
      capture.reset();
      clearField();
      return;
    }

    setBusy(true);
    try {
      const enteredUsername = username.current?.value.trim() ?? '';
      const result = await session.signup({
        username: enteredUsername,
        email: email.current?.value.trim() ?? '',
        resolved: sample.resolved,
        script: sample.script,
        // A-16: Medium by default. Crossing into Strict is a re-key, so it is a
        // settings decision (M2-14), never a signup one.
        strictness: 'medium',
        consentPolicyVersion,
        deviceName: 'This browser',
        devicePlatform: navigator.platform,
      });
      clearField();
      onComplete(result, sample.script, enteredUsername, sample.resolved);
    } catch (err) {
      setProblems([(err as Error).message]);
      capture.reset();
      clearField();
    } finally {
      setBusy(false);
    }
  };

  const stage = first === null ? 'first' : 'second';

  /**
   * Checked on click rather than used to disable the button. A disabled control with
   * no stated reason is its own usability bug — the user is left guessing which field
   * is at fault.
   */
  const identityProblems = (): string[] => {
    const problems: string[] = [];
    if ((username.current?.value ?? '').trim().length === 0) problems.push('Enter a username.');
    if ((email.current?.value ?? '').trim().length === 0) problems.push('Enter an email address.');
    if (!consented) {
      problems.push('Tick the box to agree to your typing rhythm being measured.');
    }
    return problems;
  };

  const submit = async () => {
    const blocking = identityProblems();
    if (blocking.length > 0) {
      setProblems(blocking);
      return;
    }
    await (stage === 'first' ? takeFirst() : takeSecond());
  };

  return (
    <main className="flex flex-col gap-3 p-4 font-sans text-sm">
      <h1 className="text-base font-semibold">Create your CypherKey</h1>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-600">Username</span>
        <input
          ref={username}
          data-testid="username"
          className="rounded border border-neutral-300 px-2 py-1"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-600">Email</span>
        <input
          ref={email}
          type="email"
          data-testid="email"
          className="rounded border border-neutral-300 px-2 py-1"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-600">
          {stage === 'first' ? 'Choose a passphrase' : 'Type it again, exactly the same way'}
        </span>
        <input
          ref={input}
          type="password"
          data-testid="passphrase"
          onFocus={begin}
          className="rounded border border-neutral-300 px-2 py-1"
        />
      </label>

      <RhythmLight ref={light} state={capture.state} />

      {first !== null && (
        <p data-testid="counts" className="text-xs text-neutral-700">
          {/*
            The moment Phantom Keys become comprehensible. The web demo showed that
            people do not grasp them from prose, but they do from these two numbers
            disagreeing.
          */}
          {scriptLength(first.script)} keystrokes · {[...first.resolved].length} characters
        </p>
      )}

      {problems.length > 0 && (
        <ul data-testid="problems" className="flex flex-col gap-1 text-xs text-rose-700">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <p className="text-xs text-neutral-500">
        Strictness is set to Medium. It decides how much your typing may vary from day to day; you
        can change it later in Settings.
      </p>

      <label className="flex items-start gap-2 text-xs text-neutral-700">
        <input
          type="checkbox"
          data-testid="consent"
          checked={consented}
          onChange={(e) => setConsented(e.target.checked)}
        />
        <span>
          I agree that CypherKey may measure my typing rhythm on this passphrase, and only while the
          Rhythm Light is visible. (Policy {consentPolicyVersion})
        </span>
      </label>

      <button
        type="button"
        data-testid="submit"
        disabled={busy}
        onMouseDown={preventFocusSteal}
        onClick={submit}
        className="rounded bg-neutral-900 px-2 py-1 text-white disabled:opacity-40"
      >
        {stage === 'first' ? 'Next' : 'Create account'}
      </button>
    </main>
  );
}

/** Exported for the tests that gate the button without waiting on the dictionaries. */
export { lengthProblems };
