import { describe, expect, spyOn, test } from 'bun:test';
import {
  DecryptionError,
  NONCE_BYTES,
  decryptItem,
  encryptItem,
  unwrapKey,
  wrapKey,
  xor32,
} from './aead';
import { randomBytes } from './kdf';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (s: string) => new TextEncoder().encode(s);
const KEY = new Uint8Array(32).fill(4);
const OTHER_KEY = new Uint8Array(32).fill(5);

describe('wrapKey / unwrapKey', () => {
  test('round-trips a 32-byte key', async () => {
    const vaultShare = randomBytes(32);
    const sealed = await wrapKey(vaultShare, KEY);
    expect(hex(await unwrapKey(sealed, KEY))).toBe(hex(vaultShare));
  });

  test('produces a 12-byte nonce and a ciphertext carrying the 16-byte tag', async () => {
    const sealed = await wrapKey(randomBytes(32), KEY);
    expect(sealed.nonce.length).toBe(NONCE_BYTES);
    expect(sealed.ct.length).toBe(32 + 16);
  });

  test('the wrapped key does not reveal the plaintext key', async () => {
    const key = new Uint8Array(32).fill(0xab);
    const sealed = await wrapKey(key, KEY);
    expect(hex(sealed.ct)).not.toContain(hex(key));
  });

  test('the wrong wrapping key throws', async () => {
    const sealed = await wrapKey(randomBytes(32), KEY);
    await expect(unwrapKey(sealed, OTHER_KEY)).rejects.toThrow(DecryptionError);
  });

  test('a tampered ciphertext throws', async () => {
    const sealed = await wrapKey(randomBytes(32), KEY);
    sealed.ct[0] ^= 1;
    await expect(unwrapKey(sealed, KEY)).rejects.toThrow(DecryptionError);
  });

  test('a tampered nonce throws', async () => {
    const sealed = await wrapKey(randomBytes(32), KEY);
    sealed.nonce[0] ^= 1;
    await expect(unwrapKey(sealed, KEY)).rejects.toThrow(DecryptionError);
  });

  // A-2/A-3: the same wrapKey seals both the vault share and the device private key.
  // Without domain separation, a swapped blob would unwrap as the other secret.
  test('a blob wrapped in one context does not unwrap in another', async () => {
    const sealed = await wrapKey(randomBytes(32), KEY, 'cypherkey/wrap/vault-key/v1');
    await expect(unwrapKey(sealed, KEY, 'cypherkey/wrap/device-key/v1')).rejects.toThrow(
      DecryptionError,
    );
  });

  test('rejects a wrapping key that is not 32 bytes', async () => {
    await expect(wrapKey(randomBytes(32), new Uint8Array(16))).rejects.toThrow(/32/);
  });

  test('nonces are unique across 1,000 wraps', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(hex((await wrapKey(KEY, KEY)).nonce));
    }
    expect(seen.size).toBe(1000);
  });
});

describe('encryptItem / decryptItem', () => {
  const itemId = '6f1b6b6e-0000-4000-8000-000000000001';

  test('round-trips a vault item', async () => {
    const plaintext = bytes(JSON.stringify({ title: 'GitHub', password: 'hunter2' }));
    const sealed = await encryptItem(plaintext, KEY, itemId);
    expect(new TextDecoder().decode(await decryptItem(sealed, KEY, itemId))).toBe(
      new TextDecoder().decode(plaintext),
    );
  });

  test('the ciphertext does not contain the plaintext', async () => {
    const sealed = await encryptItem(bytes('hunter2'), KEY, itemId);
    expect(Buffer.from(sealed.ct).toString('utf8')).not.toContain('hunter2');
  });

  test('the wrong item id throws — the id is the AAD (A-2)', async () => {
    const sealed = await encryptItem(bytes('secret'), KEY, itemId);
    await expect(decryptItem(sealed, KEY, '6f1b6b6e-0000-4000-8000-000000000002')).rejects.toThrow(
      DecryptionError,
    );
  });

  test('the wrong vault key throws', async () => {
    const sealed = await encryptItem(bytes('secret'), KEY, itemId);
    await expect(decryptItem(sealed, OTHER_KEY, itemId)).rejects.toThrow(DecryptionError);
  });

  test('a tampered ciphertext throws', async () => {
    const sealed = await encryptItem(bytes('secret'), KEY, itemId);
    sealed.ct[2] ^= 0x80;
    await expect(decryptItem(sealed, KEY, itemId)).rejects.toThrow(DecryptionError);
  });

  test('an item ciphertext does not decrypt as a wrapped key', async () => {
    const sealed = await encryptItem(new Uint8Array(32).fill(1), KEY, itemId);
    await expect(unwrapKey(sealed, KEY)).rejects.toThrow(DecryptionError);
  });

  test('encrypts an empty item', async () => {
    const sealed = await encryptItem(new Uint8Array(0), KEY, itemId);
    expect((await decryptItem(sealed, KEY, itemId)).length).toBe(0);
  });

  test('rejects an empty item id — AAD must bind the item', async () => {
    await expect(encryptItem(bytes('x'), KEY, '')).rejects.toThrow(/itemId/);
  });

  test('the same plaintext twice gives different ciphertext', async () => {
    const a = await encryptItem(bytes('same'), KEY, itemId);
    const b = await encryptItem(bytes('same'), KEY, itemId);
    expect(hex(a.ct)).not.toBe(hex(b.ct));
  });

  test('nonces are unique across 1,000 items', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(hex((await encryptItem(bytes('x'), KEY, itemId)).nonce));
    }
    expect(seen.size).toBe(1000);
  });
});

describe('xor32', () => {
  test('reconstructs the vault key from its two shares (A-5)', () => {
    const vaultShare = randomBytes(32);
    const serverShare = randomBytes(32);
    const vaultKey = xor32(vaultShare, serverShare);
    expect(hex(xor32(vaultKey, serverShare))).toBe(hex(vaultShare));
  });

  test('neither share alone equals the key', () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    const out = xor32(a, b);
    expect(hex(out)).not.toBe(hex(a));
    expect(hex(out)).not.toBe(hex(b));
  });

  test('is commutative and does not mutate its inputs', () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    const beforeA = hex(a);
    const beforeB = hex(b);
    expect(hex(xor32(a, b))).toBe(hex(xor32(b, a)));
    expect(hex(a)).toBe(beforeA);
    expect(hex(b)).toBe(beforeB);
  });

  test('rejects operands that are not 32 bytes', () => {
    expect(() => xor32(new Uint8Array(31), new Uint8Array(32))).toThrow(/32/);
    expect(() => xor32(new Uint8Array(32), new Uint8Array(33))).toThrow(/32/);
  });
});

describe('key material never reaches a log', () => {
  test('no operation writes to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const sealed = await wrapKey(randomBytes(32), KEY);
      await unwrapKey(sealed, KEY);
      const item = await encryptItem(bytes('secret'), KEY, 'id-1');
      await decryptItem(item, KEY, 'id-1');
      xor32(randomBytes(32), randomBytes(32));
      await unwrapKey(sealed, OTHER_KEY).catch(() => {});
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  test('a decryption failure says nothing about the key, nonce or ciphertext', async () => {
    const key = new Uint8Array(32).fill(0xbe);
    const sealed = await wrapKey(key, KEY);
    let message = '';
    try {
      await unwrapKey(sealed, OTHER_KEY);
    } catch (e) {
      message = `${String(e)} ${(e as Error).stack ?? ''}`;
    }
    expect(message).not.toContain(hex(key));
    expect(message).not.toContain(hex(sealed.nonce));
    expect(message).not.toContain(hex(sealed.ct));
  });
});
