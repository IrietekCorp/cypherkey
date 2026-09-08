import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { AuthedRequest, Credential } from '../../../core/client/session';
import { NEEDS_PASSPHRASE, Settings } from './Settings';

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

type Call = { method: string; path: string; body?: unknown };

/** A server that answers settings and devices, and records what it was asked. */
function fakeServer(
  options: { settings?: Record<string, unknown>; patchStatus?: number; devices?: unknown[] } = {},
) {
  const calls: Call[] = [];
  const state = {
    biometricEnabled: true,
    pauseUntil: null as number | null,
    thresholds: { strictness: 'medium' },
    keyVersion: 1,
    ...options.settings,
  };

  const request: AuthedRequest = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === '/user/settings' && method === 'GET') return { status: 200, body: state };
    if (path === '/user/settings') return { status: options.patchStatus ?? 200, body: state };
    if (path === '/user/devices') {
      return {
        status: 200,
        body: {
          devices: options.devices ?? [
            {
              id: 'd1',
              name: 'This laptop',
              platform: 'linux',
              lastSeenAt: 1,
              revokedAt: null,
              current: true,
            },
            { id: 'd2', name: 'Old phone', platform: 'android', lastSeenAt: 1, revokedAt: null },
          ],
        },
      };
    }
    if (method === 'DELETE') return { status: 200, body: { ok: true } };
    return { status: 404, body: { error: 'not_found' } };
  };

  return { request, calls };
}

const el = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const text = () => host.textContent ?? '';

/**
 * Stands in for the session's Argon2id pass, and records what it was asked to prove.
 *
 * The prefix is the whole point of these assertions: a body carrying the typed text is
 * the bug this screen shipped with, and one carrying `proof:` is a value only a
 * derivation could have produced.
 */
function fakeProver() {
  const asked: Credential[] = [];
  return {
    asked,
    prove: async (input: Credential) => {
      asked.push(input);
      return `proof:${input.resolved}`;
    },
  };
}

const render = async (
  request: AuthedRequest,
  onRekeyRequested: (t: 'strict' | 'medium' | 'relaxed') => void = () => {},
  prove: (input: Credential) => Promise<string> = fakeProver().prove,
) => {
  await act(async () => {
    root.render(
      <Settings
        request={request}
        accessToken="access-1"
        prove={prove}
        onRekeyRequested={onRekeyRequested}
        now={() => 1_788_000_000_000}
      />,
    );
  });
};

const click = async (id: string) => {
  await act(async () => {
    el(id)?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });
};

/**
 * Types, rather than assigning a value.
 *
 * The field is a capture field (A-14.2), so the passphrase exists only as tokenized key
 * events — a test that set `.value` would pass while the screen sent nothing. Focus
 * first: capture starts on focus, and a sample that never started cannot be stopped.
 */
const typePassphrase = async (value: string) => {
  const input = el('passphrase');
  await act(async () => {
    input?.dispatchEvent(new win.Event('focusin', { bubbles: true }));
  });
  for (const key of value) {
    await act(async () => {
      input?.dispatchEvent(
        new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
      input?.dispatchEvent(
        new win.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }),
      );
    });
  }
};

const patches = (calls: Call[]) =>
  calls.filter((c) => c.method === 'PATCH').map((c) => c.body as Record<string, unknown>);

describe('changes that weaken protection carry the passphrase (A-17)', () => {
  test('turning the rhythm off sends a derived proof, not the typed text', async () => {
    const { request, calls } = fakeServer();
    const prover = fakeProver();
    await render(request, () => {}, prover.prove);
    await typePassphrase('correct horse');

    await click('biometric');

    expect(patches(calls)).toEqual([{ biometricEnabled: false, authHash: 'proof:correct horse' }]);
    // The regression this file exists to hold: `authHash` is never the passphrase.
    expect(patches(calls)[0]?.authHash).not.toBe('correct horse');
  });

  /**
   * `kdfInput` folds the script in under Strict, so the proof is only valid at the level
   * the account is currently on. Proving at the level being asked for would derive a
   * value the server has never stored.
   */
  test('the proof is derived at the level the account is on, not the one requested', async () => {
    const { request } = fakeServer({ settings: { thresholds: { strictness: 'medium' } } });
    const prover = fakeProver();
    await render(request, () => {}, prover.prove);
    await typePassphrase('correct horse');

    await click('strictness-relaxed');

    expect(prover.asked).toHaveLength(1);
    expect(prover.asked[0]?.strictness).toBe('medium');
  });

  /** The script is what a Strict account's key is derived from, so it has to be real. */
  test('the keystrokes reach the derivation, not just the characters', async () => {
    const { request } = fakeServer();
    const prover = fakeProver();
    await render(request, () => {}, prover.prove);
    await typePassphrase('abc');

    await click('biometric');

    expect(prover.asked[0]?.resolved).toBe('abc');
    expect(prover.asked[0]?.script).toBe('abc');
  });

  test('pausing sends it', async () => {
    const { request, calls } = fakeServer();
    await render(request);
    await typePassphrase('correct horse');

    await click('pause-3600000');

    expect(patches(calls)[0]?.authHash).toBe('proof:correct horse');
    expect(patches(calls)[0]?.pauseUntil).toBe(1_788_000_000_000 + 60 * 60_000);
  });

  test('loosening Strictness sends it', async () => {
    const { request, calls } = fakeServer();
    await render(request);
    await typePassphrase('correct horse');

    await click('strictness-relaxed');

    expect(patches(calls)[0]).toEqual({
      thresholds: { strictness: 'relaxed' },
      authHash: 'proof:correct horse',
    });
  });

  test('without a passphrase typed, nothing is sent at all', async () => {
    const { request, calls } = fakeServer();
    await render(request);

    await click('biometric');

    expect(patches(calls)).toHaveLength(0);
    expect(el('message')?.textContent).toBe(NEEDS_PASSPHRASE);
  });

  /**
   * A pasted passphrase has no rhythm and, on a Strict account, no script to derive
   * from. The hook says which mistake was made; what matters here is that the screen
   * sends nothing rather than sending an unprovable value.
   */
  test('a pasted passphrase sends nothing and says why', async () => {
    const { request, calls } = fakeServer();
    await render(request);
    await typePassphrase('correct horse');
    await act(async () => {
      el('passphrase')?.dispatchEvent(new win.Event('paste', { bubbles: true }));
    });

    await click('biometric');

    expect(patches(calls)).toHaveLength(0);
    expect(el('capture-message')?.textContent).toContain('Pasting cannot be measured');
  });

  test('a refusal from the server is reported plainly', async () => {
    const { request } = fakeServer({ patchStatus: 403 });
    await render(request);
    await typePassphrase('wrong');
    // 403 is the server refusing the proof, which is the only thing it can refuse now.

    await click('biometric');
    expect(el('message')?.textContent).toContain('did not match');
  });

  /**
   * It exists for the length of one request, not the length of the screen.
   *
   * The sample is the thing to check now rather than `.value`: the keystrokes are the
   * passphrase here, so a screen that emptied the box but kept the sample would still
   * be holding it.
   */
  test('the sample is discarded after every attempt', async () => {
    const { request } = fakeServer();
    await render(request);
    await typePassphrase('correct horse');
    expect(el('rhythm-light')?.getAttribute('data-running')).toBe('true');

    await click('biometric');

    expect((el('passphrase') as unknown as HTMLInputElement).value).toBe('');
    expect(el('rhythm-light')?.getAttribute('data-running')).toBe('false');
    expect(el('rhythm-light')?.getAttribute('data-pulses')).toBe('0');
  });
});

describe('turning protection back on needs nothing', () => {
  /**
   * Requiring a factor to re-enable would strand a user whose factor is unavailable in
   * exactly the weakened state they are trying to leave.
   */
  test('re-enabling the rhythm sends no passphrase', async () => {
    const { request, calls } = fakeServer({ settings: { biometricEnabled: false } });
    await render(request);

    await click('biometric');

    expect(patches(calls)).toEqual([{ biometricEnabled: true }]);
  });

  test('un-pausing sends no passphrase', async () => {
    const { request, calls } = fakeServer({
      settings: { pauseUntil: 1_788_000_000_000 + 60_000 },
    });
    await render(request);

    await click('unpause');

    expect(patches(calls)).toEqual([{ pauseUntil: null }]);
  });
});

describe('Strictness and the re-key boundary (A-16)', () => {
  /**
   * Crossing into or out of Strict changes `kdfInput` and therefore the master key.
   * A settings PATCH cannot do it — the server refuses — so the screen hands off.
   */
  test('choosing Strict asks the popup to re-key rather than patching', async () => {
    const requested: string[] = [];
    const { request, calls } = fakeServer();
    await render(request, (t) => requested.push(t));
    await typePassphrase('correct horse');

    await click('strictness-strict');

    expect(requested).toEqual(['strict']);
    expect(patches(calls)).toHaveLength(0);
  });

  test('leaving Strict also re-keys', async () => {
    const requested: string[] = [];
    const { request, calls } = fakeServer({ settings: { thresholds: { strictness: 'strict' } } });
    await render(request, (t) => requested.push(t));

    await click('strictness-medium');

    expect(requested).toEqual(['medium']);
    expect(patches(calls)).toHaveLength(0);
  });

  test('Medium to Relaxed is an ordinary edit', async () => {
    const { request, calls } = fakeServer();
    await render(request);
    await typePassphrase('correct horse');

    await click('strictness-relaxed');
    expect(patches(calls)).toHaveLength(1);
  });

  test('the warning says what a crossing costs', async () => {
    const { request } = fakeServer();
    await render(request);
    const warning = el('strict-warning')?.textContent ?? '';
    expect(warning).toContain('re-keys');
    // The two facts a user needs before committing.
    expect(warning).toContain('Recovery Kit keeps working');
    expect(warning).toContain('sign in again');
  });
});

describe('devices', () => {
  test('they are listed', async () => {
    const { request } = fakeServer();
    await render(request);
    expect(text()).toContain('This laptop');
    expect(text()).toContain('Old phone');
  });

  test('revoking one calls the server and reports it', async () => {
    const { request, calls } = fakeServer();
    await render(request);

    await click('revoke-d2');

    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/user/devices/d2')).toBe(true);
    expect(el('message')?.textContent).toContain('no longer reach your vault');
  });

  /** Revoking the device you are using would lock you out of the screen you are on. */
  test('the current device offers no revoke button', async () => {
    const { request } = fakeServer();
    await render(request);
    expect(el('revoke-d1')).toBeNull();
    expect(el('revoke-d2')).not.toBeNull();
  });

  test('an already-revoked device is shown as such, with no button', async () => {
    const { request } = fakeServer({
      devices: [{ id: 'd3', name: 'Lost phone', platform: 'ios', lastSeenAt: 1, revokedAt: 2 }],
    });
    await render(request);
    expect(text()).toContain('revoked');
    expect(el('revoke-d3')).toBeNull();
  });
});
