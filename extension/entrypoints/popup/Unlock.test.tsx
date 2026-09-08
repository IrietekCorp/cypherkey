import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { LoginResult, Session, StepUpInput } from '../../../core/client/session';
import { FAIL_MESSAGE, GREY_MESSAGE, LOCKED_MESSAGE, LOCKOUT_WARNING, Unlock } from './Unlock';

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

type Scripted = { logins?: LoginResult[]; stepUps?: LoginResult[]; offline?: boolean };

/** A session that answers with whatever the test queued, and records what it was asked. */
function fakeSession(scripted: Scripted = {}) {
  const logins = [...(scripted.logins ?? [])];
  const stepUps = [...(scripted.stepUps ?? [])];
  const seen = { logins: [] as unknown[], stepUps: [] as StepUpInput[], offline: 0 };

  const session: UnlockSession = {
    state: () => 'locked',
    async login(input) {
      seen.logins.push(input);
      return logins.shift() ?? { band: 'fail', error: 'invalid_credentials' };
    },
    async stepUp(input) {
      seen.stepUps.push(input);
      return stepUps.shift() ?? { band: 'fail', error: 'step_up_failed' };
    },
    async unlockOffline() {
      seen.offline += 1;
      return scripted.offline ?? false;
    },
    async recover() {
      throw new Error('not used here');
    },
    async commitmentsFor(script) {
      return [...script].map((_, i) => `c${i}`);
    },
  };
  return { session, seen };
}

type UnlockSession = Pick<
  Session,
  'login' | 'stepUp' | 'unlockOffline' | 'state' | 'recover' | 'commitmentsFor'
>;

const el = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const text = () => host.textContent ?? '';

const render = async (session: UnlockSession, props: { offline?: boolean } = {}) => {
  const events = { unlocked: 0, forgot: 0, keyVersion: -1 };
  await act(async () => {
    root.render(
      <Unlock
        session={session}
        username="shawn"
        strictness="medium"
        onUnlocked={(v) => {
          events.unlocked += 1;
          events.keyVersion = v;
        }}
        onForgotPassphrase={() => {
          events.forgot += 1;
        }}
        {...props}
      />,
    );
  });
  return events;
};

const PHRASE = [...'correct horse'];

const typeAndSubmit = async (keys = PHRASE) => {
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
  await act(async () => {
    el('submit')?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });
};

const click = async (id: string) => {
  await act(async () => {
    el(id)?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });
};

describe('bands drive the screen (X-3)', () => {
  test('a pass unlocks', async () => {
    const { session } = fakeSession({ logins: [{ band: 'pass', keyVersion: 1 }] });
    const events = await render(session);

    await typeAndSubmit();
    expect(events.unlocked).toBe(1);
  });

  /** Grey is not a refusal, and the copy must not read like one. */
  test('grey asks for a second sample rather than rejecting', async () => {
    const { session } = fakeSession({ logins: [{ band: 'grey', stepUp: ['retype'] }] });
    await render(session);

    await typeAndSubmit();
    expect(el('message')?.textContent).toBe(GREY_MESSAGE);
    expect(text()).not.toContain(FAIL_MESSAGE);
    // Board copy (frame 07). "Type it again" reads as an invitation; the old
    // "Type it once more" reads as a last chance, which amber is not.
    expect(el('submit')?.textContent).toBe('Type it again');
  });

  test('a second sample after grey goes to step-up, not login', async () => {
    const { session, seen } = fakeSession({
      logins: [{ band: 'grey', stepUp: ['retype'] }],
      stepUps: [{ band: 'pass', keyVersion: 1 }],
    });
    const events = await render(session);

    await typeAndSubmit();
    await typeAndSubmit();

    expect(seen.logins).toHaveLength(1);
    expect(seen.stepUps).toHaveLength(1);
    expect(seen.stepUps[0]?.method).toBe('retype');
    expect(events.unlocked).toBe(1);
  });

  test('a fail says so and stays on the passphrase', async () => {
    const { session } = fakeSession({ logins: [{ band: 'fail', error: 'invalid_credentials' }] });
    await render(session);

    await typeAndSubmit();
    expect(el('message')?.textContent).toBe(FAIL_MESSAGE);
    expect(el('step-up')).toBeNull();
  });

  /** A failed grey retype has nowhere left to go on rhythm alone. */
  test('a failed grey retype offers a Backup Code', async () => {
    const { session } = fakeSession({
      logins: [{ band: 'grey', stepUp: ['retype'] }],
      stepUps: [{ band: 'fail', error: 'step_up_failed' }],
    });
    await render(session);

    await typeAndSubmit();
    await typeAndSubmit();

    expect(el('step-up')).not.toBeNull();
    expect(el('backup-code')).not.toBeNull();
  });
});

/**
 * No score reaches the screen, in any band.
 *
 * The design board sketched "Amber band · 0.53" and "Fail · 0.31 · RH-04". A live number
 * is the one piece of feedback an attacker can iterate against -- type, read, adjust,
 * repeat until it clears -- and it gives an honest user nothing to act on, because nobody
 * can decide how to type differently from a decimal. The band and a sentence carry the
 * whole message.
 *
 * Asserted on the rendered text rather than on a prop, so it also catches a score arriving
 * through some other route later.
 */
describe('no score is ever shown', () => {
  const noDecimal = (where: string) => {
    // 0.53, .31, 53% -- any shape a score could take on the way to the screen.
    expect(where).not.toMatch(/\d*\.\d+/);
    expect(where).not.toMatch(/\d+\s?%/);
  };

  test('the amber band shows a name, not a number', async () => {
    const { session } = fakeSession({ logins: [{ band: 'grey', stepUp: ['backup_code'] }] });
    await render(session);
    await typeAndSubmit();
    expect(el('band')?.textContent).toBe('Amber band');
    noDecimal(text());
  });

  test('a refusal shows a name, not a number or an internal code', async () => {
    const { session } = fakeSession({ logins: [{ band: 'fail', error: 'phantom_mismatch' }] });
    await render(session);
    await typeAndSubmit();
    expect(el('band')?.textContent).toBe('Refused');
    // `phantom_mismatch` is an identifier, not copy. A support code belongs in a bug
    // report, not on the screen someone is stuck on.
    expect(text()).not.toContain('phantom_mismatch');
    noDecimal(text());
  });
});

describe('step-up with a Backup Code', () => {
  const reachStepUp = async () => {
    const { session, seen } = fakeSession({
      logins: [{ band: 'grey', stepUp: ['retype'] }],
      stepUps: [
        { band: 'fail', error: 'step_up_failed' },
        { band: 'pass', keyVersion: 1 },
      ],
    });
    const events = await render(session);
    await typeAndSubmit();
    await typeAndSubmit();
    return { seen, events };
  };

  test('a Backup Code clears step-up and unlocks', async () => {
    const { seen, events } = await reachStepUp();

    await act(async () => {
      (el('backup-code') as unknown as HTMLInputElement).value = 'ABCDE-FGHJK';
    });
    await click('use-backup-code');

    const sent = seen.stepUps[1];
    expect(sent?.method).toBe('backup_code');
    // Assert the code itself travelled: asserting only the method would pass even if
    // the field were never read.
    expect(sent?.method === 'backup_code' ? sent.proof : null).toBe('ABCDE-FGHJK');
    expect(events.unlocked).toBe(1);
  });

  /** The word is load-bearing: a Backup Code opens a session, the Kit opens a vault. */
  test('it says Backup Code, never "recovery code"', async () => {
    await reachStepUp();
    expect(text()).toContain('Backup Code');
    expect(text().toLowerCase()).not.toContain('recovery code');
  });

  /**
   * Frame 08 omits the Recovery Kit link, and that omission is a rule rather than a
   * layout choice: a Backup Code opens one session, the Kit opens the vault and re-keys
   * the account, discarding the rhythm profile. Offering both at the moment someone is
   * failing a rhythm check puts the destructive option in front of a frustrated user.
   */
  test('a way back to typing is offered instead', async () => {
    await reachStepUp();
    expect(el('retry-typing')).not.toBeNull();
    await click('retry-typing');
    // Back to a plain entry screen: the band, the message and the step-up are all gone.
    expect(el('step-up')).toBeNull();
    expect(el('band')).toBeNull();
    expect(el('submit')?.textContent).toBe('Unlock');
  });

  test('the Recovery Kit is not offered as a step-up factor', async () => {
    await reachStepUp();
    // The Kit belongs to the forgot-passphrase path, which is a different thing.
    expect(text()).not.toContain('Recovery Kit');
  });
});

describe('lockout is warned about before it happens', () => {
  test('repeated failures warn without claiming a precise count', async () => {
    const { session } = fakeSession({
      logins: [
        { band: 'fail', error: 'invalid_credentials' },
        { band: 'fail', error: 'invalid_credentials' },
      ],
    });
    await render(session);

    await typeAndSubmit();
    expect(el('lockout-warning')).toBeNull();

    await typeAndSubmit();
    expect(el('lockout-warning')?.textContent).toBe(LOCKOUT_WARNING);
    // The server never reports how many attempts remain, so no number is claimed.
    expect(LOCKOUT_WARNING).not.toMatch(/\d+ attempts? (remain|left)/);
  });

  test('an actual lockout says so and still offers a Backup Code', async () => {
    const { session } = fakeSession({ logins: [{ band: 'fail', error: 'locked_out' }] });
    await render(session);

    await typeAndSubmit();
    expect(el('message')?.textContent).toBe(LOCKED_MESSAGE);
    expect(el('backup-code')).not.toBeNull();
    expect((el('passphrase') as unknown as HTMLInputElement).disabled).toBe(true);
  });
});

describe('offline unlock (A-7)', () => {
  test('a cached blob opens the vault with no server', async () => {
    const { session, seen } = fakeSession({ offline: true });
    const events = await render(session, { offline: true });

    await typeAndSubmit();

    expect(seen.offline).toBe(1);
    expect(seen.logins).toHaveLength(0);
    expect(events.unlocked).toBe(1);
    expect(el('offline')).not.toBeNull();
  });

  test('no cached blob fails cleanly rather than throwing', async () => {
    const { session } = fakeSession({ offline: false });
    const events = await render(session, { offline: true });

    await typeAndSubmit();

    expect(events.unlocked).toBe(0);
    expect(el('message')?.textContent).toContain('offline vault');
  });
});

describe('forgotten passphrase', () => {
  test('it hands off to the recovery flow rather than unwrapping here', async () => {
    const { session } = fakeSession();
    const events = await render(session);

    await click('forgot');
    expect(events.forgot).toBe(1);
  });
});

describe('the key version reaches the cache', () => {
  /** M2-09: a re-key elsewhere makes every cached blob on this device undecryptable. */
  test('a pass reports the account key version', async () => {
    const { session } = fakeSession({ logins: [{ band: 'pass', keyVersion: 7 }] });
    const events = await render(session);

    await typeAndSubmit();
    expect(events.keyVersion).toBe(7);
  });

  test('an offline unlock reports 0, because there is no server to ask', async () => {
    const { session } = fakeSession({ offline: true });
    const events = await render(session, { offline: true });

    await typeAndSubmit();
    // The cache keeps what it believes; a re-key is detected on the next online unlock,
    // which is the earliest it can be known.
    expect(events.keyVersion).toBe(0);
  });
});
