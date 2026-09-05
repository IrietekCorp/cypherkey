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
  const events = { unlocked: 0, forgot: 0 };
  await act(async () => {
    root.render(
      <Unlock
        session={session}
        username="shawn"
        strictness="medium"
        onUnlocked={() => {
          events.unlocked += 1;
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
    const { session } = fakeSession({ logins: [{ band: 'pass' }] });
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
    expect(el('submit')?.textContent).toBe('Type it once more');
  });

  test('a second sample after grey goes to step-up, not login', async () => {
    const { session, seen } = fakeSession({
      logins: [{ band: 'grey', stepUp: ['retype'] }],
      stepUps: [{ band: 'pass' }],
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

describe('step-up with a Backup Code', () => {
  const reachStepUp = async () => {
    const { session, seen } = fakeSession({
      logins: [{ band: 'grey', stepUp: ['retype'] }],
      stepUps: [{ band: 'fail', error: 'step_up_failed' }, { band: 'pass' }],
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
