import { useState } from 'react';
import { band } from '../../../core/biometrics/score';
import type { AuthedRequest, Session } from '../../../core/client/session';
import { rhythmBands } from '../../../core/crypto/phantom';
import type { Strictness } from '../../../core/crypto/phantom';
import { RhythmLight } from '../../src/components/RhythmLight';
import { preventFocusSteal, useCapture } from '../../src/components/useCapture';

/**
 * X-7, the party trick: hand someone your passphrase and watch it not work.
 *
 * Every decision here comes from a complaint the web demo actually produced, so they
 * are worth naming rather than rediscovering:
 *
 *  - one attempt reads as a fluke, so a friend gets **three** and a visible counter;
 *  - the owner has not seen their own passphrase for several minutes by the time the
 *    keyboard comes back, so it is **shown again**;
 *  - "0.69 PASS" beside "Stolen password neutralized" was the single most confusing
 *    thing in the demo, so the verdict is **derived from the band** and cannot disagree
 *    with it;
 *  - the Strictness lever **re-judges attempts already recorded**, so the trade-off is
 *    felt rather than described.
 */

export const MAX_ATTEMPTS = 3;

export type Attempt = {
  who: 'friend' | 'owner';
  score: number;
  phantomsMatched: boolean;
};

export type PartyTrickProps = {
  session: Pick<Session, 'authed' | 'commitmentsFor' | 'tokens'>;
  /** The script the owner enrolled, shown back to them when their turn comes. */
  resolved: string;
  strictness: Strictness;
  onDone(): void;
};

type Stage = 'intro' | 'friend' | 'owner' | 'results';

/**
 * The verdict, as a pure function of the band.
 *
 * Not written alongside the score: that is how "PASS" ended up next to "neutralized".
 */
export function verdictFor(who: Attempt['who'], result: 'pass' | 'grey' | 'fail'): string {
  if (who === 'friend') {
    if (result === 'pass') return 'They got in — their rhythm matched yours closely enough.';
    if (result === 'grey') return 'Borderline: CypherKey would ask them to type it again.';
    return 'Refused. They had your passphrase and it was not enough.';
  }
  if (result === 'pass') return 'You are in, as expected.';
  if (result === 'grey') return 'Borderline for you too — try once more, that happens.';
  return 'Refused — that did not look like your usual rhythm either.';
}

export function PartyTrick({ session, resolved, strictness, onDone }: PartyTrickProps) {
  const capture = useCapture();
  const [stage, setStage] = useState<Stage>('intro');
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [lever, setLever] = useState<Strictness>(strictness);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const [light, setLight] = useState<HTMLDivElement | null>(null);

  const friendAttempts = attempts.filter((a) => a.who === 'friend');
  const bands = rhythmBands(lever);
  const bandOf = (attempt: Attempt) =>
    attempt.phantomsMatched ? band(attempt.score, bands.pass, bands.grey) : 'fail';

  const begin = () => {
    if (input !== null && light !== null) {
      setMessage(null);
      capture.start(input, light);
    }
  };

  const score = async (who: Attempt['who']) => {
    const sample = capture.stop();
    if (sample === null) return;
    if (input !== null) input.value = '';

    setBusy(true);
    try {
      const request: AuthedRequest = session.authed();
      const commitments = await session.commitmentsFor(sample.script);
      const res = await request(
        'POST',
        '/user/demo-score',
        { featureVector: sample.featureVector, commitments },
        session.tokens()?.accessToken ?? '',
      );
      if (res.status !== 200) {
        setMessage('That attempt could not be scored. Try again.');
        return;
      }

      const body = res.body as { score: number; phantomsMatched: boolean };
      const next = [...attempts, { who, score: body.score, phantomsMatched: body.phantomsMatched }];
      setAttempts(next);
      capture.reset();

      if (who === 'owner') setStage('results');
      else if (next.filter((a) => a.who === 'friend').length >= MAX_ATTEMPTS) setStage('owner');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setAttempts([]);
    setStage('friend');
    setMessage(null);
    capture.reset();
  };

  return (
    <main className="flex flex-col gap-3 p-4 font-sans text-sm">
      <h1 className="text-base font-semibold">Try it on someone</h1>

      {stage === 'intro' && (
        <>
          <p className="text-xs text-neutral-600">
            Show a friend your passphrase and let them type it. CypherKey does not check what they
            typed — it checks how.
          </p>
          <code data-testid="intro-phrase" className="rounded bg-neutral-100 p-2 text-xs">
            {resolved}
          </code>
          <button
            type="button"
            data-testid="start"
            onClick={() => setStage('friend')}
            className="self-start rounded bg-neutral-900 px-2 py-1 text-white"
          >
            Hand over the keyboard
          </button>
        </>
      )}

      {stage === 'friend' && (
        <>
          <p data-testid="counter" className="text-xs text-neutral-600">
            {/* One attempt reads as a fluke. Three, counted out loud, does not. */}
            Attempt {friendAttempts.length + 1} of {MAX_ATTEMPTS}
          </p>
          <code data-testid="friend-phrase" className="rounded bg-neutral-100 p-2 text-xs">
            {resolved}
          </code>
        </>
      )}

      {stage === 'owner' && (
        <>
          <p className="text-xs text-neutral-600">Your turn. Type it as you normally would.</p>
          {/* The owner has not seen this for several minutes. */}
          <code data-testid="owner-phrase" className="rounded bg-neutral-100 p-2 text-xs">
            {resolved}
          </code>
        </>
      )}

      {(stage === 'friend' || stage === 'owner') && (
        <>
          <input
            ref={setInput}
            type="text"
            data-testid="passphrase"
            onFocus={begin}
            disabled={busy}
            className="rounded border border-neutral-300 px-2 py-1"
          />
          <RhythmLight ref={setLight} state={capture.state} />
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="submit"
              disabled={busy}
              onMouseDown={preventFocusSteal}
              onClick={() => score(stage === 'friend' ? 'friend' : 'owner')}
              className="rounded bg-neutral-900 px-2 py-1 text-white disabled:opacity-40"
            >
              Try it
            </button>
            {stage === 'friend' && (
              // Three attempts is a ceiling, not a requirement.
              <button
                type="button"
                data-testid="give-up"
                onClick={() => setStage('owner')}
                className="rounded border border-neutral-300 px-2 py-1"
              >
                Give up
              </button>
            )}
          </div>
        </>
      )}

      {message !== null && (
        <p data-testid="message" className="text-xs text-rose-700">
          {message}
        </p>
      )}

      {attempts.length > 0 && (
        <ul data-testid="attempts" className="flex flex-col gap-2">
          {attempts.map((attempt, i) => {
            const result = bandOf(attempt);
            return (
              <li key={`${attempt.who}-${i}-${attempt.score}`} className="flex flex-col">
                <span data-testid={`band-${i}`} className="text-xs font-medium">
                  {attempt.who === 'friend' ? 'Them' : 'You'} · {result}
                </span>
                {/* Derived from the band, never written beside it. */}
                <span data-testid={`verdict-${i}`} className="text-xs text-neutral-600">
                  {verdictFor(attempt.who, result)}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {stage === 'results' && (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-neutral-600">
              Move the lever and watch the same attempts be judged differently.
            </span>
            <div className="flex gap-2">
              {(['relaxed', 'medium', 'strict'] as const).map((level) => (
                <button
                  key={level}
                  type="button"
                  data-testid={`lever-${level}`}
                  onClick={() => setLever(level)}
                  className={`rounded border px-2 py-1 text-xs ${
                    lever === level
                      ? 'border-neutral-900 bg-neutral-900 text-white'
                      : 'border-neutral-300'
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              data-testid="another"
              onClick={reset}
              className="rounded border border-neutral-300 px-2 py-1"
            >
              Test another person
            </button>
            <button
              type="button"
              data-testid="done"
              onClick={onDone}
              className="rounded bg-neutral-900 px-2 py-1 text-white"
            >
              Done
            </button>
          </div>
        </>
      )}
    </main>
  );
}
