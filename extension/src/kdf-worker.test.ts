import { describe, expect, test } from 'bun:test';
import { deriveMasterKey } from '../../core/crypto/kdf';
import { handleKdfRequest, warmUp } from './kdf-worker';

const FAST = { m: 256, t: 1, p: 1 } as const;
const SALT = new Uint8Array(16).fill(7);
const INPUT = new TextEncoder().encode('correct horse battery staple');

describe('handleKdfRequest', () => {
  /**
   * The point of the worker is that it is the *same* Argon2id. If the worker path and
   * the direct path ever diverged, every account derived on one would be unopenable by
   * the other, and nothing else in the system would notice.
   */
  test('returns exactly what a direct deriveMasterKey returns', async () => {
    const direct = await deriveMasterKey(INPUT, SALT, FAST);
    const viaWorker = await handleKdfRequest({ id: 1, kdfInput: INPUT, salt: SALT, params: FAST });

    expect(viaWorker.ok).toBe(true);
    if (viaWorker.ok) expect(viaWorker.key).toEqual(direct);
  });

  test('carries the request id back, so concurrent requests cannot be confused', async () => {
    const [a, b] = await Promise.all([
      handleKdfRequest({ id: 11, kdfInput: INPUT, salt: SALT, params: FAST }),
      handleKdfRequest({ id: 22, kdfInput: INPUT, salt: new Uint8Array(16).fill(9), params: FAST }),
    ]);
    expect(a?.id).toBe(11);
    expect(b?.id).toBe(22);
  });

  test('a bad argument comes back as an error, not a throw', async () => {
    const result = await handleKdfRequest({
      id: 1,
      kdfInput: new Uint8Array(0),
      salt: SALT,
      params: FAST,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('kdfInput');
  });

  /** Errors name the argument, never its contents. */
  test('an error never echoes the input', async () => {
    const result = await handleKdfRequest({
      id: 1,
      kdfInput: INPUT,
      salt: new Uint8Array(4),
      params: FAST,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain('correct horse');
      expect(result.error).toContain('salt');
    }
  });

  test('warmUp compiles the module without throwing', async () => {
    await warmUp();
  });
});
