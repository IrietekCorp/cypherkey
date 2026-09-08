import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { AuthedRequest, Credential, Session } from '../../../core/client/session';
import { createLockController } from '../../src/lock';
import { RESUME_IDLE_MS, saveResume } from '../../src/resume';
import { type StorageArea, memoryArea } from '../../src/storage';
import { CLOSED_MESSAGES, NO_PROMPT_HERE, OptionsApp, REKEY_MESSAGE } from './OptionsApp';

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

const T0 = 1_788_000_000_000;

const SNAPSHOT = {
  vaultKey: 'A'.repeat(43),
  wrapKey: 'B'.repeat(43),
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  keyVersion: 1,
};

/**
 * A session that answers settings, and records whether it was ever resumed.
 *
 * `resumeFrom` is the whole seam this screen turns on, so the double reports it rather
 * than pretending: a page that rendered settings without resuming would be a page making
 * requests with no keys behind them.
 */
function fakeSession(options: { resumable?: boolean; settingsStatus?: number } = {}) {
  const resumed: string[] = [];
  let unlocked = false;

  const request: AuthedRequest = async (method, path) => {
    if (!unlocked) return { status: 401, body: { error: 'unauthorized' } };
    if (path === '/user/settings' && method === 'GET') {
      return {
        status: options.settingsStatus ?? 200,
        body: {
          biometricEnabled: true,
          pauseUntil: null,
          thresholds: { strictness: 'medium' },
          keyVersion: 1,
        },
      };
    }
    if (path === '/user/devices') {
      return { status: 200, body: { devices: [] } };
    }
    return { status: 404, body: { error: 'not_found' } };
  };

  const session = {
    authed: () => request,
    tokens: () => (unlocked ? { accessToken: 'access-1', refreshToken: 'refresh-1' } : null),
    refresh: async () => false,
    resumeFrom: (snapshot: { accessToken: string }) => {
      if (options.resumable === false) return false;
      resumed.push(snapshot.accessToken);
      unlocked = true;
      return true;
    },
    authProof: async (input: Credential) => `proof:${input.resolved}`,
    lock: () => {
      unlocked = false;
    },
    state: () => (unlocked ? 'unlocked' : 'locked'),
  } as unknown as Session;

  return { session, resumed };
}

const el = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const text = () => host.textContent ?? '';

const render = async (props: {
  memory: StorageArea | null;
  session?: ReturnType<typeof fakeSession>;
  watch?: (listener: () => void) => () => void;
  lock?: ReturnType<typeof createLockController>;
}) => {
  const built = props.session ?? fakeSession();
  await act(async () => {
    root.render(
      <OptionsApp
        session={built.session}
        memory={props.memory}
        now={() => T0}
        watch={props.watch ?? (() => () => {})}
        {...(props.lock === undefined ? {} : { lock: props.lock })}
      />,
    );
  });
  return built;
};

describe('the options page finds its own session', () => {
  test('a resumable snapshot opens the settings screen', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0);
    const built = await render({ memory: area });

    expect(built.resumed).toEqual(['access-1']);
    expect(text()).toContain('Strictness');
    expect(el('closed-message')).toBeNull();
  });

  /** Being the second document, "no session" is the ordinary case, not an error. */
  test('nothing stored asks the user to unlock in the popup', async () => {
    await render({ memory: memoryArea() });

    expect(el('closed-message')?.textContent).toBe(CLOSED_MESSAGES.none);
  });

  test('an expired session says the deadline it hit', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0 - RESUME_IDLE_MS - 1);

    await render({ memory: area });

    expect(el('closed-message')?.textContent).toBe(CLOSED_MESSAGES.idle);
  });

  test('a snapshot the session refuses is treated as no session', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0);

    await render({ memory: area, session: fakeSession({ resumable: false }) });

    expect(el('closed-message')?.textContent).toBe(CLOSED_MESSAGES.malformed);
  });

  /** Outside the extension there is no session area at all. */
  test('no session storage is the same answer, not a crash', async () => {
    await render({ memory: null });

    expect(el('closed-message')?.textContent).toBe(CLOSED_MESSAGES.none);
  });

  /**
   * The decision this screen exists to record: a second passphrase prompt, on a page
   * nobody expects one, is exactly the shape a phishing page takes.
   */
  test('the closed screen says why it does not simply ask for the passphrase', async () => {
    await render({ memory: memoryArea() });

    expect(el('no-prompt-here')?.textContent).toBe(NO_PROMPT_HERE);
    expect(host.querySelector('[data-testid="passphrase"]')).toBeNull();
  });
});

describe('it keeps up with the popup', () => {
  test('unlocking in the popup opens this page without a reload', async () => {
    const area = memoryArea();
    let notify: (() => void) | null = null;
    const built = await render({
      memory: area,
      watch: (listener) => {
        notify = listener;
        return () => {};
      },
    });
    expect(el('closed-message')).not.toBeNull();

    await saveResume(area, SNAPSHOT, 'shawn', T0);
    await act(async () => (notify as unknown as () => void)());

    expect(built.resumed).toEqual(['access-1']);
    expect(text()).toContain('Strictness');
  });

  /**
   * A manual lock in the popup clears the snapshot. Leaving this page open and unlocked
   * would be a second unlocked surface behind the one the user just locked.
   */
  test('locking in the popup closes this page too', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0);
    let notify: (() => void) | null = null;
    await render({
      memory: area,
      watch: (listener) => {
        notify = listener;
        return () => {};
      },
    });
    expect(text()).toContain('Strictness');

    await area.remove('cypherkey.session.resume');
    await act(async () => (notify as unknown as () => void)());

    expect(el('closed-message')?.textContent).toBe(CLOSED_MESSAGES.none);
  });

  /**
   * The page touches the snapshot on the way in, and that write is a change to the very
   * area it is watching. Without the guard the notification would drive another touch,
   * and the page would write to storage in a loop for as long as it was open.
   */
  test('being notified does not start a write loop', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0);
    let notify: (() => void) | null = null;
    const writes: string[] = [];
    const counted: StorageArea = {
      get: (keys) => area.get(keys),
      set: async (items) => {
        writes.push('set');
        await area.set(items);
      },
      remove: (keys) => area.remove(keys),
    };
    await render({
      memory: counted,
      watch: (listener) => {
        notify = listener;
        return () => {};
      },
    });
    const afterOpen = writes.length;

    await act(async () => (notify as unknown as () => void)());
    await act(async () => (notify as unknown as () => void)());

    expect(afterOpen).toBe(1);
    expect(writes).toHaveLength(afterOpen);
  });
});

describe('the page locks itself', () => {
  /**
   * A-5, for a document that can sit open for days. The snapshot bounds the snapshot;
   * this tab holds the vault key in its own heap and has to bound itself.
   */
  test('an idle lock closes the screen', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0);
    const controller = createLockController({
      session: { lock: () => {}, state: () => 'unlocked' },
      setInterval: () => 0,
      clearInterval: () => {},
    });
    await render({ memory: area, lock: controller });
    expect(text()).toContain('Strictness');

    await act(async () => controller.lock('idle'));

    expect(el('closed-message')?.textContent).toBe(CLOSED_MESSAGES.locked);
  });

  /** It must not sign the popup out: an idle tab is not an idle browser. */
  test('locking this page leaves the shared session alone', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0);
    const controller = createLockController({
      session: { lock: () => {}, state: () => 'unlocked' },
      setInterval: () => 0,
      clearInterval: () => {},
    });
    await render({ memory: area, lock: controller });

    await act(async () => controller.lock('idle'));

    expect(await area.get('cypherkey.session.resume')).not.toEqual({});
  });
});

describe('the Strict crossing', () => {
  test('is refused here, and says where it belongs', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0);
    await render({ memory: area });

    await act(async () => {
      el('strictness-strict')?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    });

    expect(el('rekey-notice')?.textContent).toBe(REKEY_MESSAGE);
  });
});
