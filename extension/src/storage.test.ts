import { describe, expect, test } from 'bun:test';
import { createSession } from '../../core/client/session';
import { toBase64Url } from '../../core/crypto/encoding';
import { PERSISTED_KEYS, extensionStorage, memoryArea } from './storage';

const FAST = { m: 256, t: 1, p: 1 } as const;

describe('extensionStorage', () => {
  test('round-trips a value', async () => {
    const storage = extensionStorage(memoryArea());
    expect(await storage.get('k')).toBeNull();
    await storage.set('k', 'v');
    expect(await storage.get('k')).toBe('v');
  });

  test('remove really removes', async () => {
    const area = memoryArea();
    const storage = extensionStorage(area);
    await storage.set('k', 'v');
    await storage.remove('k');
    expect(await storage.get('k')).toBeNull();
    expect(area.dump()).toEqual({});
  });

  /**
   * A foreign or corrupted entry must fail closed. If a non-string came back as-is,
   * `loadDevice` would try to unwrap it instead of reporting "no device".
   */
  test('a non-string value reads as absent', async () => {
    const area = memoryArea();
    await area.set({ 'cypherkey.device.id': { not: 'a string' } });
    expect(await extensionStorage(area).get('cypherkey.device.id')).toBeNull();
  });

  test('keys are independent', async () => {
    const storage = extensionStorage(memoryArea());
    await storage.set('a', '1');
    await storage.set('b', '2');
    await storage.remove('a');
    expect(await storage.get('b')).toBe('2');
  });
});

/**
 * The adapter is only correct if the real client library can run on it, so this drives
 * an actual signup rather than asserting on the shape of the interface.
 */
describe('core/client runs on it', () => {
  const mockServer = () => {
    const serverShare = new Uint8Array(32).fill(0x5a);
    return (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const json = (status: number, value: unknown) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (path === '/auth/signup') {
        return json(201, {
          userId: 'user-1',
          serverShare: toBase64Url(serverShare),
          enrollmentToken: 'enroll-token-1',
          backupCodes: Array.from({ length: 10 }, (_, i) => `AAAAA-0000${i}`),
        });
      }
      if (path === '/auth/recovery-key') return json(200, { ok: true });
      return json(404, { error: 'not_found' });
    }) as unknown as typeof fetch;
  };

  const signup = async (area: ReturnType<typeof memoryArea>) => {
    const session = createSession({
      baseUrl: 'https://api.cypherkey.test',
      fetch: mockServer(),
      storage: extensionStorage(area),
      argonParams: FAST,
    });
    const result = await session.signup({
      username: 'shawn',
      email: 'shawn@example.test',
      resolved: 'correct horse battery staple',
      script: 'correct horse battery staple',
      strictness: 'medium',
      consentPolicyVersion: '2026-09-01',
      deviceName: 'Chrome',
      devicePlatform: 'linux',
    });
    return { session, result };
  };

  test('a full signup persists through the adapter', async () => {
    const area = memoryArea();
    const { session, result } = await signup(area);
    expect(result.userId).toBe('user-1');
    expect(session.state()).toBe('unlocked');
  });

  /**
   * A-7 absence test. This is the check that matters most in the extension: anything
   * that lands in `chrome.storage.local` survives the popup closing.
   */
  test('storage holds only the five keys A-7 permits', async () => {
    const area = memoryArea();
    await signup(area);
    expect(Object.keys(area.dump()).sort()).toEqual([...PERSISTED_KEYS].sort());
  });

  test('no passphrase, script, or key material is persisted', async () => {
    const area = memoryArea();
    const { session } = await signup(area);
    const dump = JSON.stringify(area.dump());

    expect(dump).not.toContain('correct horse');
    expect(dump).not.toContain(toBase64Url(session.vaultKey()));
    for (const forbidden of ['phantom', 'authHash', 'wrapKey', 'passphrase', 'featureVector']) {
      expect(dump).not.toContain(forbidden);
    }
  });
});
