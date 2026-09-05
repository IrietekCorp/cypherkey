import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { AuthedRequest } from '../../../core/client/session';
import { Settings } from './Settings';

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

const render = async (
  request: AuthedRequest,
  onRekeyRequested: (t: 'strict' | 'medium' | 'relaxed') => void = () => {},
) => {
  await act(async () => {
    root.render(
      <Settings
        request={request}
        accessToken="access-1"
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

const typePassphrase = async (value: string) => {
  await act(async () => {
    (el('passphrase') as unknown as HTMLInputElement).value = value;
  });
};

const patches = (calls: Call[]) =>
  calls.filter((c) => c.method === 'PATCH').map((c) => c.body as Record<string, unknown>);

describe('changes that weaken protection carry the passphrase (A-17)', () => {
  test('turning the rhythm off sends it', async () => {
    const { request, calls } = fakeServer();
    await render(request);
    await typePassphrase('correct horse');

    await click('biometric');

    expect(patches(calls)).toEqual([{ biometricEnabled: false, authHash: 'correct horse' }]);
  });

  test('pausing sends it', async () => {
    const { request, calls } = fakeServer();
    await render(request);
    await typePassphrase('correct horse');

    await click('pause-3600000');

    expect(patches(calls)[0]?.authHash).toBe('correct horse');
    expect(patches(calls)[0]?.pauseUntil).toBe(1_788_000_000_000 + 60 * 60_000);
  });

  test('loosening Strictness sends it', async () => {
    const { request, calls } = fakeServer();
    await render(request);
    await typePassphrase('correct horse');

    await click('strictness-relaxed');

    expect(patches(calls)[0]).toEqual({
      thresholds: { strictness: 'relaxed' },
      authHash: 'correct horse',
    });
  });

  test('without a passphrase typed, nothing is sent at all', async () => {
    const { request, calls } = fakeServer();
    await render(request);

    await click('biometric');

    expect(patches(calls)).toHaveLength(0);
    expect(el('message')?.textContent).toContain('Enter your passphrase');
  });

  test('a refusal from the server is reported plainly', async () => {
    const { request } = fakeServer({ patchStatus: 403 });
    await render(request);
    await typePassphrase('wrong');

    await click('biometric');
    expect(el('message')?.textContent).toContain('did not match');
  });

  /** It exists for the length of one request, not the length of the screen. */
  test('the field is cleared after every attempt', async () => {
    const { request } = fakeServer();
    await render(request);
    await typePassphrase('correct horse');

    await click('biometric');
    expect((el('passphrase') as unknown as HTMLInputElement).value).toBe('');
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
