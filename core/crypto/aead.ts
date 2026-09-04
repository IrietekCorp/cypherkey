import { KEY_BYTES, randomBytes } from './kdf';

/** AES-GCM nonce length. 12 bytes is the only size the construction is defined for. */
export const NONCE_BYTES = 12;

/** AES-GCM authentication tag, in bits, as WebCrypto wants it. */
const TAG_BITS = 128;

/** A ciphertext with the nonce it was produced under. The tag is appended to `ct`. */
export type Sealed = { ct: Uint8Array; nonce: Uint8Array };

/**
 * Domain separator for wrapped keys. The same `wrapKey` seals both the vault share
 * (A-2) and the device private key (A-3); binding each blob to its purpose stops one
 * being substituted for the other, since both are 32 opaque bytes.
 */
export type WrapContext =
  | 'cypherkey/wrap/vault-key/v1'
  | 'cypherkey/wrap/device-key/v1'
  /** A-7 offline cache. Wraps the FULL vaultKey, not the share — a distinct plaintext
   *  under the same wrapKey, so it needs its own label or it could be substituted. */
  | 'cypherkey/wrap/vault-key-offline/v1';

/** Thrown when a ciphertext does not authenticate. Carries no detail about why. */
export class DecryptionError extends Error {
  override readonly name = 'DecryptionError';
  constructor() {
    super('decryption failed: key, nonce, ciphertext or associated data does not match');
  }
}

const utf8 = new TextEncoder();

function assertKey(name: string, key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`${name} must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
}

/** Imports raw bytes as a non-extractable AES-GCM key. */
async function importAesKey(raw: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [usage]);
}

/** Encrypts under a fresh random nonce, binding `aad` into the tag. */
async function seal(plaintext: Uint8Array, key: Uint8Array, aad: Uint8Array): Promise<Sealed> {
  const nonce = randomBytes(NONCE_BYTES);
  const cryptoKey = await importAesKey(key, 'encrypt');
  const ct = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce as BufferSource,
      additionalData: aad as BufferSource,
      tagLength: TAG_BITS,
    },
    cryptoKey,
    plaintext as BufferSource,
  );
  return { ct: new Uint8Array(ct), nonce };
}

/** Decrypts, or throws `DecryptionError`. Any failure looks identical from outside. */
async function open(sealed: Sealed, key: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  if (sealed.nonce.length !== NONCE_BYTES) {
    throw new DecryptionError();
  }
  const cryptoKey = await importAesKey(key, 'decrypt');
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: sealed.nonce as BufferSource,
        additionalData: aad as BufferSource,
        tagLength: TAG_BITS,
      },
      cryptoKey,
      sealed.ct as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    // Deliberately swallow the driver's error: it must not describe the failure.
    throw new DecryptionError();
  }
}

/**
 * Wraps a 32-byte key under a 32-byte wrapping key, bound to its purpose.
 * Used for `wrappedVaultKey`, `recoveryWrappedVaultKey` and the device private key.
 */
export async function wrapKey(
  key: Uint8Array,
  wrappingKey: Uint8Array,
  context: WrapContext = 'cypherkey/wrap/vault-key/v1',
): Promise<Sealed> {
  assertKey('key', key);
  assertKey('wrappingKey', wrappingKey);
  return seal(key, wrappingKey, utf8.encode(context));
}

/** Reverses `wrapKey`. Throws `DecryptionError` on the wrong key, a tampered blob, or the wrong context. */
export async function unwrapKey(
  wrapped: Sealed,
  wrappingKey: Uint8Array,
  context: WrapContext = 'cypherkey/wrap/vault-key/v1',
): Promise<Uint8Array> {
  assertKey('wrappingKey', wrappingKey);
  const key = await open(wrapped, wrappingKey, utf8.encode(context));
  if (key.length !== KEY_BYTES) {
    key.fill(0);
    throw new DecryptionError();
  }
  return key;
}

/** Encrypts one vault item under the vault key, with the item id as AAD (A-2). */
export async function encryptItem(
  plaintext: Uint8Array,
  vaultKey: Uint8Array,
  itemId: string,
): Promise<Sealed> {
  assertKey('vaultKey', vaultKey);
  if (itemId.length === 0) {
    throw new Error('encryptItem: itemId must not be empty');
  }
  return seal(plaintext, vaultKey, utf8.encode(itemId));
}

/** Reverses `encryptItem`. The item id must match the one it was sealed with. */
export async function decryptItem(
  sealed: Sealed,
  vaultKey: Uint8Array,
  itemId: string,
): Promise<Uint8Array> {
  assertKey('vaultKey', vaultKey);
  if (itemId.length === 0) {
    throw new Error('decryptItem: itemId must not be empty');
  }
  return open(sealed, vaultKey, utf8.encode(itemId));
}

/**
 * XORs two 32-byte values. A-5: `vaultKey = vaultShare XOR serverShare`.
 * Returns a new array; neither operand is modified.
 */
export function xor32(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== KEY_BYTES || b.length !== KEY_BYTES) {
    throw new Error(
      `xor32: both operands must be ${KEY_BYTES} bytes, got ${a.length} and ${b.length}`,
    );
  }
  const out = new Uint8Array(KEY_BYTES);
  for (let i = 0; i < KEY_BYTES; i++) {
    out[i] = (a[i] as number) ^ (b[i] as number);
  }
  return out;
}
