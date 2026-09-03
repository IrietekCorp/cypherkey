import { describe, expect, spyOn, test } from 'bun:test';
import { argon2id } from '@noble/hashes/argon2';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { ARGON_PARAMS, deriveMasterKey, deriveSubkey, randomBytes } from './kdf';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (s: string) => new TextEncoder().encode(s);
/** Argon2id at A-2 strength takes ~1s; tests that don't measure strength use these. */
const FAST = { m: 256, t: 1, p: 1 } as const;
const SALT = new Uint8Array(16).fill(7);

describe('known-answer vectors for the primitives underneath', () => {
  // RFC 9106 §5.3 Argon2id test vector. Proves @noble/hashes computes real Argon2id,
  // which is the part a wrapper cannot self-verify.
  test('Argon2id matches RFC 9106', () => {
    const out = argon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), {
      t: 3,
      m: 32,
      p: 4,
      dkLen: 32,
      version: 0x13,
      key: new Uint8Array(8).fill(3),
      personalization: new Uint8Array(12).fill(4),
    });
    expect(hex(out)).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });

  // RFC 5869 Test Case 1, HKDF-SHA256.
  test('HKDF-SHA256 matches RFC 5869', () => {
    const out = hkdf(
      sha256,
      new Uint8Array(22).fill(0x0b),
      Uint8Array.from(Array.from({ length: 13 }, (_, i) => i)),
      Uint8Array.from([0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9]),
      42,
    );
    expect(hex(out)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });
});

describe('frozen vectors for our own wrappers', () => {
  // Committed so that a change to params, info strings, hash or ordering breaks the build.
  // Regenerate deliberately, never to make a red test go green.
  test('deriveMasterKey is stable for fixed input, salt and params', async () => {
    const key = await deriveMasterKey(bytes('correct horse battery staple'), SALT, FAST);
    expect(hex(key)).toBe('4f787b05275f6f47250f8d76d361d280f065610940c1cd0ded5184af715ca92d');
  });

  test('each subkey is stable for a fixed master key', async () => {
    const master = new Uint8Array(32).fill(9);
    expect(hex(await deriveSubkey(master, 'cypherkey/auth/v1'))).toBe(
      '216a6537223c52ceab08af8fa4e96ae93e212929088d2a761e8ec833d5974aac',
    );
    expect(hex(await deriveSubkey(master, 'cypherkey/wrap/v1'))).toBe(
      '204e79132cbb4f5e888fac0683ab8079c6ae4989ad72f8f62503245291552707',
    );
    expect(hex(await deriveSubkey(master, 'cypherkey/phantom/v1'))).toBe(
      '6c1818298da12a9cd2fcaebd7f69a02f591e736161455d6ba88d5c4d97509aed',
    );
  });

  // Independent of the frozen constants above: the wrappers must be exactly the
  // primitive calls docs/02 A-2 and A-14.2 describe, with no extra steps.
  test('deriveMasterKey is Argon2id over the documented parameters', async () => {
    const input = bytes('correct horse battery staple');
    expect(hex(await deriveMasterKey(input, SALT, FAST))).toBe(
      hex(argon2id(input, SALT, { ...FAST, dkLen: 32, version: 0x13 })),
    );
  });

  test('deriveSubkey is HKDF-SHA256 over the info label, unsalted', async () => {
    const master = new Uint8Array(32).fill(9);
    expect(hex(await deriveSubkey(master, 'cypherkey/wrap/v1'))).toBe(
      hex(hkdf(sha256, master, undefined, bytes('cypherkey/wrap/v1'), 32)),
    );
  });
});

describe('deriveMasterKey', () => {
  test('returns 32 bytes', async () => {
    expect((await deriveMasterKey(bytes('pw'), SALT, FAST)).length).toBe(32);
  });

  test('different salts give different keys', async () => {
    const a = await deriveMasterKey(bytes('pw'), new Uint8Array(16).fill(1), FAST);
    const b = await deriveMasterKey(bytes('pw'), new Uint8Array(16).fill(2), FAST);
    expect(hex(a)).not.toBe(hex(b));
  });

  test('different inputs give different keys', async () => {
    const a = await deriveMasterKey(bytes('pw'), SALT, FAST);
    const b = await deriveMasterKey(bytes('pX'), SALT, FAST);
    expect(hex(a)).not.toBe(hex(b));
  });

  test('is deterministic', async () => {
    const a = await deriveMasterKey(bytes('pw'), SALT, FAST);
    const b = await deriveMasterKey(bytes('pw'), SALT, FAST);
    expect(hex(a)).toBe(hex(b));
  });

  // M1-17 will feed this `resolved ‖ 0x00 ‖ script` in Strict mode.
  test('treats the input as bytes, so an embedded NUL separates', async () => {
    const joined = await deriveMasterKey(Uint8Array.from([0x61, 0x00, 0x62]), SALT, FAST);
    const concatenated = await deriveMasterKey(Uint8Array.from([0x61, 0x62]), SALT, FAST);
    expect(hex(joined)).not.toBe(hex(concatenated));
  });

  test('defaults to the A-2 parameters', () => {
    expect(ARGON_PARAMS).toEqual({ m: 65536, t: 3, p: 1 });
  });

  test('rejects a salt that is not 16 bytes', async () => {
    await expect(deriveMasterKey(bytes('pw'), new Uint8Array(8), FAST)).rejects.toThrow(/salt/i);
  });

  test('rejects an empty input', async () => {
    await expect(deriveMasterKey(new Uint8Array(0), SALT, FAST)).rejects.toThrow();
  });
});

describe('deriveSubkey', () => {
  const master = new Uint8Array(32).fill(3);

  test('returns 32 bytes', async () => {
    expect((await deriveSubkey(master, 'cypherkey/wrap/v1')).length).toBe(32);
  });

  test('the three subkeys differ from each other and from the master key', async () => {
    const auth = await deriveSubkey(master, 'cypherkey/auth/v1');
    const wrap = await deriveSubkey(master, 'cypherkey/wrap/v1');
    const phantom = await deriveSubkey(master, 'cypherkey/phantom/v1');
    const all = [hex(auth), hex(wrap), hex(phantom), hex(master)];
    expect(new Set(all).size).toBe(4);
  });

  test('is deterministic', async () => {
    expect(hex(await deriveSubkey(master, 'cypherkey/auth/v1'))).toBe(
      hex(await deriveSubkey(master, 'cypherkey/auth/v1')),
    );
  });

  test('different master keys give different subkeys', async () => {
    const a = await deriveSubkey(new Uint8Array(32).fill(1), 'cypherkey/auth/v1');
    const b = await deriveSubkey(new Uint8Array(32).fill(2), 'cypherkey/auth/v1');
    expect(hex(a)).not.toBe(hex(b));
  });

  test('rejects a master key that is not 32 bytes', async () => {
    await expect(deriveSubkey(new Uint8Array(16), 'cypherkey/auth/v1')).rejects.toThrow(/32/);
  });

  test('does not mutate the master key it was given', async () => {
    const original = new Uint8Array(32).fill(5);
    await deriveSubkey(original, 'cypherkey/auth/v1');
    expect(hex(original)).toBe(hex(new Uint8Array(32).fill(5)));
  });
});

describe('randomBytes', () => {
  test('returns the requested length', () => {
    expect(randomBytes(32).length).toBe(32);
    expect(randomBytes(12).length).toBe(12);
  });

  test('does not return zeros, and does not repeat', () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(a.every((v) => v === 0)).toBe(false);
    expect(hex(a)).not.toBe(hex(b));
  });

  test('rejects a non-positive or non-integer length', () => {
    expect(() => randomBytes(0)).toThrow();
    expect(() => randomBytes(-1)).toThrow();
    expect(() => randomBytes(1.5)).toThrow();
  });
});

describe('key material never reaches a log', () => {
  test('no derivation writes to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const master = await deriveMasterKey(bytes('correct horse'), SALT, FAST);
      await deriveSubkey(master, 'cypherkey/auth/v1');
      await deriveSubkey(master, 'cypherkey/wrap/v1');
      await deriveSubkey(master, 'cypherkey/phantom/v1');
      randomBytes(32);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  test('a validation error names the argument but never its bytes', async () => {
    const secret = bytes('super-secret-passphrase');
    let message = '';
    try {
      await deriveMasterKey(secret, new Uint8Array(3), FAST);
    } catch (e) {
      message = String(e);
    }
    expect(message).toMatch(/salt/i);
    expect(message).not.toContain('super-secret');
    expect(message).not.toContain(hex(secret));
  });
});
