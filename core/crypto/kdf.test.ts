import { describe, expect, spyOn, test } from 'bun:test';
import { argon2id as nobleArgon2id } from '@noble/hashes/argon2';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { argon2id } from 'hash-wasm';
import { ARGON_PARAMS, deriveMasterKey, deriveSubkey, randomBytes } from './kdf';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (s: string) => new TextEncoder().encode(s);
/** Argon2id at A-2 strength takes ~1s; tests that don't measure strength use these. */
const FAST = { m: 256, t: 1, p: 1 } as const;
const SALT = new Uint8Array(16).fill(7);

describe('known-answer vectors for the primitives underneath', () => {
  // RFC 9106 §5.3. This vector uses a secret AND associated data; hash-wasm exposes
  // `secret` but has no `ad` parameter, so the vector cannot be computed by our
  // production implementation. It is verified against @noble instead, which anchors
  // the algorithm; the two tests below then tie hash-wasm to that anchor for the
  // no-secret, no-ad shape we actually use. See the M1-03 notes.
  test('Argon2id matches RFC 9106 §5.3 (via @noble — hash-wasm has no `ad`)', () => {
    const out = nobleArgon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), {
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

  // A direct known-answer test for the implementation we actually ship: the
  // phc-winner-argon2 reference CLI vector, `-id -t 2 -m 16 -p 1`, no secret, no ad.
  test('hash-wasm Argon2id matches the phc-winner-argon2 reference vector', async () => {
    const out = await argon2id({
      password: bytes('password'),
      salt: bytes('somesalt'),
      iterations: 2,
      parallelism: 1,
      memorySize: 65536,
      hashLength: 32,
      outputType: 'binary',
    });
    expect(hex(out)).toBe('09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7');
  });

  // Ties the shipped implementation to the RFC-anchored one on our own parameter shape.
  test('hash-wasm and @noble agree on Argon2id at our parameters', async () => {
    const input = bytes('correct horse battery staple');
    const fromWasm = await argon2id({
      password: input,
      salt: SALT,
      iterations: FAST.t,
      parallelism: FAST.p,
      memorySize: FAST.m,
      hashLength: 32,
      outputType: 'binary',
    });
    const fromNoble = nobleArgon2id(input, SALT, { ...FAST, dkLen: 32, version: 0x13 });
    expect(hex(fromWasm)).toBe(hex(fromNoble));
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
      hex(
        await argon2id({
          password: input,
          salt: SALT,
          iterations: FAST.t,
          parallelism: FAST.p,
          memorySize: FAST.m,
          hashLength: 32,
          outputType: 'binary',
        }),
      ),
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
