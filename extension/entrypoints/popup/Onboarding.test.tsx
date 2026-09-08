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
        backupCodes: Array.from({ length: 10 }, (_, i) => `AAAAA-0000${i}`),
      } satisfies SignupResult;
    },
  };
  return { session, calls };
}

const el = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const text = () => host.textContent ?? '';

/** Captures the "I already have an account" choice for assertions. */
const hasAccount: { name: string | null } = { name: null };

const render = async (
  session: Pick<Session, 'signup'>,
  onComplete: (r: SignupResult) => void = () => {},
) => {
  await act(async () => {
    root.render(
      <Onboarding
        session={session}
        consentPolicyVersion="2026-09-01"
        onComplete={onComplete}
        onHasAccount={(name) => {
          hasAccount.name = name;
        }}
      />,
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

const focusField = () => (el('passphrase') as unknown as { focus(): void }).focus();
const fieldValue = () => (el('passphrase') as unknown as { value: string }).value;

/** Types into whichever field already holds focus, without re-focusing it. */
const typeIntoFocusedField = async (keys: string[]) => {
  const field = el('passphrase');
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

/**
 * Reported from real onboarding: the passphrase "doesn't seem to be captured
 * consistently". The consent checkbox sat below the passphrase field, which made it a
 * trap rather than a checkbox. Ticking it means leaving the input, leaving the input
 * fires `blur`, and a blur voids the sample. Anyone who typed the passphrase before
 * ticking was told to tick the box, and ticking it destroyed what they had just typed.
 */
describe('nothing below the passphrase field can void a sample', () => {
  test('consent comes before the passphrase in the document', async () => {
    const { session } = fakeSession();
    await render(session);
    const consent = el('consent');
    const passphrase = el('passphrase');
    expect(consent).not.toBeNull();
    expect(passphrase).not.toBeNull();
    // Node.compareDocumentPosition: 4 === DOCUMENT_POSITION_FOLLOWING, i.e. the
    // passphrase comes after consent. Order is the whole fix, so order is the assertion.
    const following = (consent as unknown as Node).compareDocumentPosition(
      passphrase as unknown as Node,
    );
    expect(following & 4).toBe(4);
  });

  test('consent is above the username too, so the flow reads top to bottom', async () => {
    const { session } = fakeSession();
    await render(session);
    const consent = el('consent');
    const username = el('username');
    const following = (consent as unknown as Node).compareDocumentPosition(
      username as unknown as Node,
    );
    expect(following & 4).toBe(4);
  });

  /**
   * If a blocking field is still empty, the sample in progress is already doomed --
   * fixing that field means leaving the passphrase input. It is discarded here and said
   * so, rather than surfacing later as an unrelated capture error.
   */
  test('a blocked submit discards the doomed sample and says to retype', async () => {
    const { session } = fakeSession();
    await render(session);
    await check('consent');
    // Username deliberately left empty.
    await typePassphrase(PHRASE);
    await click('submit');

    expect(el('problems')?.textContent).toContain('Enter a username');
    expect(el('problems')?.textContent).toContain('type your passphrase again');
  });
});

/**
 * Field order is deliberate. The username is the one field the server can refuse, so it
 * is the last thing decided before the passphrase -- a rejection then costs the least
 * back-tracking. Reported after a real signup: "I wish I would have known that my
 * username was already taken. I think I should enter that after email."
 */
describe('the fields are ordered so a refusal costs least', () => {
  const order = async () => {
    const { session } = fakeSession();
    await render(session);
    const ids = ['consent', 'email', 'username', 'passphrase'];
    const nodes = ids.map((id) => el(id));
    for (const [i, node] of nodes.entries()) expect(node, ids[i]).not.toBeNull();
    return nodes;
  };

  test('consent, then email, then username, then the passphrase', async () => {
    const nodes = await order();
    for (let i = 0; i < nodes.length - 1; i++) {
      const following = (nodes[i] as unknown as Node).compareDocumentPosition(
        nodes[i + 1] as unknown as Node,
      );
      // 4 === DOCUMENT_POSITION_FOLLOWING
      expect(following & 4).toBe(4);
    }
  });
});

/**
 * Reaching an existing account without failing a signup first.
 *
 * The request was a lookup on the email that routes to login. That is a user-enumeration
 * oracle, and `/auth/salt` spends a fake deterministic salt specifically to deny one --
 * for a password manager, confirming that someone has an account is itself a
 * disclosure. A link the user chooses leaks nothing.
 */
describe('an existing account can be reached without a failed signup', () => {
  test('the choice carries the username that was typed', async () => {
    hasAccount.name = null;
    const { session, calls } = fakeSession();
    await render(session);
    await fill('username', 'shawn');

    await click('have-account');

    expect(hasAccount.name).toBe('shawn');
    // Nothing is asked of the server: no signup, and no lookup either.
    expect(calls).toHaveLength(0);
  });

  test('without a username it asks for one rather than guessing', async () => {
    hasAccount.name = null;
    const { session } = fakeSession();
    await render(session);

    await click('have-account');

    expect(hasAccount.name).toBeNull();
    expect(el('problems')?.textContent).toContain('Enter your username');
  });
});

/** The status must never claim to be armed when it is not. */
describe('the light says which state it is actually in', () => {
  test('idle before the field is touched, ready once it is', async () => {
    const { session } = fakeSession();
    await render(session);
    expect(host.textContent).toContain('Idle');

    await act(async () =>
      el('passphrase')?.dispatchEvent(new win.Event('focusin', { bubbles: true })),
    );
    expect(host.textContent).toContain('Ready');
    expect(host.textContent).not.toContain('Idle');
  });

  test('recording once keys arrive', async () => {
    const { session } = fakeSession();
    await render(session);
    await typePassphrase([...'abc']);
    expect(host.textContent).toContain('Recording your rhythm');
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

/**
 * Reported from real onboarding: after pressing Enter, "the input for the 2nd try
 * doesn't fully re-render... I see an input with idle status. It's only when I click
 * away and click back into the input that I see the prompt to enter the passphrase a
 * 2nd time."
 *
 * Capture is armed by `onFocus`, and Enter submits without ever leaving the field, so
 * the second sample was never armed: the value cleared, the light dropped to Idle, and
 * the keystrokes went nowhere. Clicking out and back in was the only recovery, and
 * nothing on screen suggested it.
 */
describe('Enter advances to the second attempt with capture still armed', () => {
  const pressEnter = async () => {
    await act(async () => {
      el('passphrase')?.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
  };

  test('the second attempt is armed without re-entering the field', async () => {
    const { session } = fakeSession();
    await render(session);
    await identify();

    // `focus()` rather than a synthetic focusin: the re-arm is guarded on the field
    // genuinely holding focus, so the test has to give it focus for real.
    await act(async () => focusField());
    await typeIntoFocusedField(PHRASE);
    await pressEnter();

    // It advanced...
    expect(text()).toContain('Type it again');
    // ...the field is empty for the retype...
    expect(fieldValue()).toBe('');
    // ...and it is recording again, rather than sitting Idle until clicked away and back.
    expect(text()).not.toContain('Idle');
    expect(text()).toContain('Ready');
  });

  test('a field the user has left is not armed behind their back', async () => {
    const { session } = fakeSession();
    await render(session);
    await identify();

    await act(async () => focusField());
    await typeIntoFocusedField(PHRASE);
    // Focus elsewhere before the sample is submitted by the button.
    await act(async () => (el('username') as unknown as { focus(): void }).focus());
    await click('submit');

    // Whatever happened, capture must not have re-armed a field nobody is typing in.
    expect(text()).not.toContain('Recording your rhythm');
  });
});

/**
 * Reported from real onboarding: a signup error "stayed in the error state the whole
 * time. There didn't seem to be a way to reset". Every failure path re-arms the current
 * attempt, which is right for a slip and useless for anything that will fail again --
 * the screen kept the error, kept the first script, and asked for the same second
 * attempt forever.
 */
describe('there is always a way out', () => {
  test('no escape hatch on a blank screen', async () => {
    const { session } = fakeSession();
    await render(session);
    expect(el('start-over')).toBeNull();
  });

  test('a failed signup can be abandoned and restarted', async () => {
    const session: Pick<Session, 'signup'> = {
      signup: async () => {
        throw new Error("Failed to execute 'fetch' on 'Window': Illegal invocation");
      },
    };
    await render(session);
    await identify();

    await typePassphrase(PHRASE);
    await click('submit');
    await typePassphrase(PHRASE);
    await click('submit');

    // Stuck: the error is shown and the screen still wants the second attempt.
    expect(text()).toContain('Illegal invocation');
    expect(text()).toContain('Type it again');

    await click('start-over');

    // Back to a first attempt, with the error and the captured script both gone.
    expect(text()).not.toContain('Illegal invocation');
    expect(text()).toContain('Choose a passphrase');
    expect(el('counts')).toBeNull();
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
