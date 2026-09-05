import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session, SignupInput, SignupResult } from '../../../core/client/session';
import { warmStrength } from '../../src/passphrase-strength';
import { Onboarding } from './Onboarding';

let win: Window;
let host: ReturnType<Window['document']['createElement']>;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  // The dictionaries load lazily. Warming them here keeps `assessPassphrase` a
  // microtask, so React's act() flushes the state it sets; otherwise the import
  // resolves after act returns and the assertions read a stale DOM.
  await warmStrength();
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

/** Records what signup was asked to do, without doing any crypto. */
function fakeSession() {
  const calls: SignupInput[] = [];
  const session: Pick<Session, 'signup'> = {
    async signup(input) {
      calls.push(input);
      return {
        userId: 'user-1',
        recoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-H',
        enrollmentToken: 'enroll-token-1',
      } satisfies SignupResult;
    },
  };
  return { session, calls };
}

const el = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const text = () => host.textContent ?? '';

const render = async (
  session: Pick<Session, 'signup'>,
  onComplete: (r: SignupResult) => void = () => {},
) => {
  await act(async () => {
    root.render(
      <Onboarding session={session} consentPolicyVersion="2026-09-01" onComplete={onComplete} />,
    );
  });
};

/**
 * The identity fields are uncontrolled, so setting the value is all that is needed —
 * no event, no React change tracking. That is also why they are uncontrolled: React's
 * onChange does not fire under happy-dom at all, for a controlled input, however the
 * value is set or the event dispatched. Verified across four dispatch variants.
 */
const fill = async (id: string, value: string) => {
  await act(async () => {
    (el(id) as unknown as HTMLInputElement).value = value;
  });
};

/**
 * React maps `onChange` on a checkbox to the native **click**, not `change`. Setting
 * `.checked` and dispatching `change` leaves React's state untouched, which silently
 * left the submit button disabled and every assertion reading a stale first stage.
 */
const check = async (id: string) => {
  await act(async () => {
    el(id)?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });
};

const click = async (id: string) => {
  await act(async () => {
    el(id)?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });
};

/** Types a passphrase into the captured field as real key events. */
const typePassphrase = async (keys: string[]) => {
  const field = el('passphrase');
  await act(async () => field?.dispatchEvent(new win.Event('focusin', { bubbles: true })));
  for (const key of keys) {
    await act(async () => {
      field?.dispatchEvent(
        new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
      field?.dispatchEvent(
        new win.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }),
      );
    });
  }
};

/** "correct horse" with a Phantom Key: a doubled r that is corrected away. */
const PHRASE = [...'correct horse'];
const WITH_PHANTOM = [...'corr', 'r', 'Backspace', ...'ect horse'];

const identify = async () => {
  await fill('username', 'shawn');
  await fill('email', 'shawn@example.test');
  await check('consent');
};

describe('identity and consent gate the button', () => {
  /**
   * The button stays enabled and says what is missing. A disabled control with no
   * stated reason is its own usability bug: the user is left guessing which field is
   * at fault, and on this screen there are three candidates.
   */
  test('submitting with nothing filled in names every missing field', async () => {
    const { session, calls } = fakeSession();
    await render(session);

    await click('submit');

    const problems = el('problems')?.textContent ?? '';
    expect(problems).toContain('Enter a username.');
    expect(problems).toContain('Enter an email address.');
    expect(problems).toContain('Tick the box');
    expect(calls).toHaveLength(0);
  });

  /** A-12: consent is explicit and cannot be skipped. */
  test('consent alone is enough to block submission', async () => {
    const { session, calls } = fakeSession();
    await render(session);
    await fill('username', 'shawn');
    await fill('email', 'shawn@example.test');

    await typePassphrase(PHRASE);
    await click('submit');

    expect(el('problems')?.textContent).toContain('Tick the box');
    expect(calls).toHaveLength(0);
  });

  test('the consent line names the policy version', async () => {
    const { session } = fakeSession();
    await render(session);
    expect(text()).toContain('2026-09-01');
  });
});

describe('passphrase strength', () => {
  test('a weak passphrase is refused and never reaches the second pass', async () => {
    const { session, calls } = fakeSession();
    await render(session);
    await identify();

    await typePassphrase([...'password12345']);
    await click('submit');

    expect(text()).toContain('guessable');
    expect(el('counts')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('a short passphrase says how short it is', async () => {
    const { session } = fakeSession();
    await render(session);
    await identify();

    await typePassphrase([...'short']);
    await click('submit');
    expect(text()).toContain('has 5');
  });
});

describe('the script is captured twice and must be token-identical (A-14)', () => {
  test('two identical scripts complete signup', async () => {
    const { session, calls } = fakeSession();
    let completed: SignupResult | null = null;
    await render(session, (r) => {
      completed = r;
    });
    await identify();

    await typePassphrase(PHRASE);
    await click('submit');
    await typePassphrase(PHRASE);
    await click('submit');

    expect(calls).toHaveLength(1);
    expect(completed).not.toBeNull();
  });

  /**
   * The whole point of A-14: the same resolved text typed a different way is a
   * different credential. If this compared resolved text, phantoms would not be part
   * of the credential at all.
   */
  test('the same text typed with different keys is refused', async () => {
    const { session, calls } = fakeSession();
    await render(session);
    await identify();

    await typePassphrase(PHRASE);
    await click('submit');
    await typePassphrase(WITH_PHANTOM);
    await click('submit');

    expect(text()).toContain('different sequence of keys');
    expect(calls).toHaveLength(0);
  });

  test('a mismatch can be retried without starting over', async () => {
    const { session, calls } = fakeSession();
    await render(session);
    await identify();

    await typePassphrase(PHRASE);
    await click('submit');
    await typePassphrase(WITH_PHANTOM);
    await click('submit');
    // Still on the second pass: the first capture is not discarded.
    await typePassphrase(PHRASE);
    await click('submit');

    expect(calls).toHaveLength(1);
  });
});

describe('what the screen shows', () => {
  test('keystrokes and characters are both shown, and differ when phantoms are used', async () => {
    const { session } = fakeSession();
    await render(session);
    await identify();

    await typePassphrase(WITH_PHANTOM);
    await click('submit');

    const counts = el('counts')?.textContent ?? '';
    // 15 keystrokes resolve to 13 characters: the doubled r and its Backspace vanish.
    expect(counts).toContain('15 keystrokes');
    expect(counts).toContain('13 characters');
  });

  test('Strictness is stated as Medium without being offered', async () => {
    const { session } = fakeSession();
    await render(session);
    expect(text()).toContain('Medium');
    expect(text()).toContain('change it later in Settings');
    expect(host.querySelector('select')).toBeNull();
  });
});

describe('what signup is given', () => {
  test('it receives the credential, not KDF bytes', async () => {
    const { session, calls } = fakeSession();
    await render(session);
    await identify();
    await typePassphrase(PHRASE);
    await click('submit');
    await typePassphrase(PHRASE);
    await click('submit');

    const input = calls[0];
    expect(input?.resolved).toBe('correct horse');
    expect(input?.strictness).toBe('medium');
    expect(input?.consentPolicyVersion).toBe('2026-09-01');
    // The session derives all three A-2 branches itself; this screen never does crypto.
    expect(input).not.toHaveProperty('kdfInput');
  });

  test('the passphrase field is cleared once signup succeeds', async () => {
    const { session } = fakeSession();
    await render(session);
    await identify();
    await typePassphrase(PHRASE);
    await click('submit');
    await typePassphrase(PHRASE);
    await click('submit');

    expect((el('passphrase') as unknown as HTMLInputElement).value).toBe('');
  });

  test('a signup failure is shown rather than swallowed', async () => {
    const failing: Pick<Session, 'signup'> = {
      async signup() {
        throw new Error('signup failed with status 409');
      },
    };
    await render(failing);
    await identify();
    await typePassphrase(PHRASE);
    await click('submit');
    await typePassphrase(PHRASE);
    await click('submit');

    expect(text()).toContain('409');
  });
});
