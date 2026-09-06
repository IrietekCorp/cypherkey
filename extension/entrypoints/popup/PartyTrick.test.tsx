import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { band } from '../../../core/biometrics/score';
import type { AuthedRequest, Session } from '../../../core/client/session';
import { rhythmBands } from '../../../core/crypto/phantom';
import { MAX_ATTEMPTS, PartyTrick, verdictFor } from './PartyTrick';

let win: Window;
let host: ReturnType<Window['document']['createElement']>;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  win = new Window();
  for (const key of [
    'window',
    'document',
    'HTMLElement',
    'Element',
    'Node',
    'navigator',
    'MouseEvent',
    'KeyboardEvent',
    'Event',
  ]) {
    (globalThis as Record<string, unknown>)[key] = (win as unknown as Record<string, unknown>)[key];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = win.document.createElement('div');
  win.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

const PHRASE = 'correct horse';

/** A server that answers with whatever scores the test queued. */
function fakeSession(scores: Array<{ score: number; phantomsMatched?: boolean }>) {
  const queued = [...scores];
  const calls: string[] = [];

  const request: AuthedRequest = async (_method, path) => {
    calls.push(path);
    const next = queued.shift() ?? { score: 0.2 };
    return {
      status: 200,
      body: {
        score: next.score,
        phantomsMatched: next.phantomsMatched ?? true,
        strictness: 'medium',
      },
    };
  };

  const session: Pick<Session, 'authed' | 'commitmentsFor' | 'tokens'> = {
    authed: () => request,
    commitmentsFor: async (script) => [...script].map((_, i) => `c${i}`),
    tokens: () => ({ accessToken: 'access-1', refreshToken: 'refresh-1' }),
  };
  return { session, calls };
}

const el = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const text = () => host.textContent ?? '';

const render = async (scores: Array<{ score: number; phantomsMatched?: boolean }>) => {
  const { session, calls } = fakeSession(scores);
  const done = { count: 0 };
  await act(async () => {
    root.render(
      <PartyTrick
        session={session}
        resolved={PHRASE}
        strictness="medium"
        onDone={() => {
          done.count += 1;
        }}
      />,
    );
  });
  return { calls, done };
};

const click = async (id: string) => {
  await act(async () => {
    el(id)?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });
};

const typeAndSubmit = async () => {
  const field = el('passphrase');
  await act(async () => field?.dispatchEvent(new win.Event('focusin', { bubbles: true })));
  for (const key of PHRASE) {
    await act(async () => {
      field?.dispatchEvent(
        new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
      field?.dispatchEvent(
        new win.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }),
      );
    });
  }
  await click('submit');
};

describe('the friend gets three tries and a way out', () => {
  /** One attempt reads as a fluke. Three, counted out loud, does not. */
  test('the counter is visible and advances', async () => {
    await render([{ score: 0.2 }, { score: 0.3 }]);
    await click('start');

    expect(el('counter')?.textContent).toContain(`1 of ${MAX_ATTEMPTS}`);
    await typeAndSubmit();
    expect(el('counter')?.textContent).toContain(`2 of ${MAX_ATTEMPTS}`);
  });

  test('after three attempts it moves to the owner', async () => {
    await render([{ score: 0.2 }, { score: 0.25 }, { score: 0.3 }]);
    await click('start');
    for (let i = 0; i < MAX_ATTEMPTS; i++) await typeAndSubmit();

    expect(el('counter')).toBeNull();
    expect(el('owner-phrase')).not.toBeNull();
  });

  /** Three is a ceiling, not a requirement. */
  test('giving up early moves on without spending the attempts', async () => {
    await render([{ score: 0.2 }]);
    await click('start');
    await typeAndSubmit();
    await click('give-up');

    expect(el('owner-phrase')).not.toBeNull();
    expect(el('give-up')).toBeNull();
  });
});

describe('the passphrase is shown when it is needed', () => {
  test('the friend can see what to type', async () => {
    await render([]);
    await click('start');
    expect(el('friend-phrase')?.textContent).toBe(PHRASE);
  });

  /** The owner has not seen it for several minutes by the time the keyboard returns. */
  test('the owner is reminded of it before their turn', async () => {
    await render([{ score: 0.2 }]);
    await click('start');
    await typeAndSubmit();
    await click('give-up');

    expect(el('owner-phrase')?.textContent).toBe(PHRASE);
  });
});

describe('the verdict cannot disagree with the band', () => {
  /**
   * "0.69 PASS" beside "Stolen password neutralized" was the single most confusing
   * thing in the web demo. The verdict is derived from the band, never written
   * alongside it.
   */
  test('verdictFor is a pure function of who and the band', () => {
    expect(verdictFor('friend', 'pass')).toContain('got in');
    expect(verdictFor('friend', 'fail')).toContain('Refused');
    expect(verdictFor('owner', 'pass')).toContain('You are in');
    // No two bands share a verdict, so the two can never read as contradicting.
    const friendVerdicts = (['pass', 'grey', 'fail'] as const).map((b) => verdictFor('friend', b));
    expect(new Set(friendVerdicts).size).toBe(3);
  });

  test('a passing friend is never told they were neutralized', async () => {
    await render([{ score: 0.95 }]);
    await click('start');
    await typeAndSubmit();

    expect(el('band-0')?.textContent).toContain('pass');
    expect(el('verdict-0')?.textContent).toContain('got in');
    expect(el('verdict-0')?.textContent).not.toContain('Refused');
  });

  test('a failing friend is told they were refused', async () => {
    await render([{ score: 0.2 }]);
    await click('start');
    await typeAndSubmit();

    expect(el('band-0')?.textContent).toContain('fail');
    expect(el('verdict-0')?.textContent).toContain('not enough');
  });

  /** The phantom check is decisive whatever the rhythm score says. */
  test('a phantom mismatch fails however well the rhythm scored', async () => {
    await render([{ score: 0.99, phantomsMatched: false }]);
    await click('start');
    await typeAndSubmit();

    expect(el('band-0')?.textContent).toContain('fail');
  });
});

describe('the Strictness lever re-judges what is already recorded', () => {
  /**
   * A score that sits between Relaxed's and Strict's pass thresholds is what makes the
   * trade-off felt rather than described.
   */
  const between = () => {
    const relaxed = rhythmBands('relaxed');
    const strict = rhythmBands('strict');
    const score = (relaxed.pass + strict.pass) / 2;
    expect(band(score, relaxed.pass, relaxed.grey)).toBe('pass');
    expect(band(score, strict.pass, strict.grey)).not.toBe('pass');
    return score;
  };

  test('moving the lever changes the verdict on an attempt already made', async () => {
    const score = between();
    await render([{ score }]);
    await click('start');
    await typeAndSubmit();
    await click('give-up');
    await typeAndSubmit();

    await click('lever-relaxed');
    const relaxed = el('band-0')?.textContent;
    await click('lever-strict');
    const strict = el('band-0')?.textContent;

    // Same attempt, no new capture, different judgement.
    expect(relaxed).not.toBe(strict);
  });

  test('the verdict moves with the band, not independently', async () => {
    const score = between();
    await render([{ score }]);
    await click('start');
    await typeAndSubmit();
    await click('give-up');
    await typeAndSubmit();

    await click('lever-strict');
    const strictBand = el('band-0')?.textContent ?? '';
    const strictVerdict = el('verdict-0')?.textContent ?? '';
    expect(strictVerdict).toBe(
      verdictFor(
        'friend',
        strictBand.includes('pass') ? 'pass' : strictBand.includes('grey') ? 'grey' : 'fail',
      ),
    );
  });
});

describe('testing another person', () => {
  test('it clears the attempts and starts over', async () => {
    await render([{ score: 0.2 }, { score: 0.9 }]);
    await click('start');
    await typeAndSubmit();
    await click('give-up');
    await typeAndSubmit();

    expect(el('attempts')).not.toBeNull();
    await click('another');

    expect(el('attempts')).toBeNull();
    expect(el('counter')?.textContent).toContain(`1 of ${MAX_ATTEMPTS}`);
  });

  test('it does not re-enrol: no enrolment call is made', async () => {
    const { calls } = await render([{ score: 0.2 }, { score: 0.9 }]);
    await click('start');
    await typeAndSubmit();
    await click('give-up');
    await typeAndSubmit();
    await click('another');

    expect(calls.every((path) => path === '/user/demo-score')).toBe(true);
    expect(calls.some((path) => path.includes('enroll'))).toBe(false);
  });

  test('done reports through', async () => {
    const { done } = await render([{ score: 0.2 }]);
    await click('start');
    await click('give-up');
    await typeAndSubmit();

    await click('done');
    expect(done.count).toBe(1);
  });
});

describe('what it never does', () => {
  /** Scoring through /auth/login would march the owner toward a lockout mid-demo. */
  test('every score goes through the side-effect-free route', async () => {
    const { calls } = await render([{ score: 0.2 }, { score: 0.3 }]);
    await click('start');
    await typeAndSubmit();
    await typeAndSubmit();

    expect(calls).toEqual(['/user/demo-score', '/user/demo-score']);
  });

  test('no raw score is shown to the friend', async () => {
    await render([{ score: 0.234_567 }]);
    await click('start');
    await typeAndSubmit();

    // A number invites hill-climbing, and means nothing to the person reading it.
    expect(text()).not.toContain('0.23');
  });
});
