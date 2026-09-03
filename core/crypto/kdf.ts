import { argon2id } from '@noble/hashes/argon2';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';

/** Argon2id cost parameters. `m` is memory in KiB. */
export type ArgonParams = { m: number; t: number; p: number };

/** docs/02 A-2: m=64 MiB, t=3, p=1. Overridden only by tests that are not measuring strength. */
export const ARGON_PARAMS: ArgonParams = { m: 65536, t: 3, p: 1 };

/** Every key in the hierarchy is 32 bytes. */
export const KEY_BYTES = 32;

/** docs/02 A-2: `userSalt` is a random 16-byte value held server-side and fetched pre-auth. */
export const SALT_BYTES = 16;

/** The HKDF labels of A-2 and A-14.2. One master key, three separated children. */
export type SubkeyInfo = 'cypherkey/auth/v1' | 'cypherkey/wrap/v1' | 'cypherkey/phantom/v1';

const ARGON_VERSION = 0x13;

/**
 * Derives the 32-byte master key from KDF input bytes and the user's salt.
 *
 * Takes bytes rather than a string because Strict mode feeds it
 * `resolved ‖ 0x00 ‖ script` (A-14.2), which is not a valid string boundary.
 * Rejections name the offending argument and never its contents.
 */
export async function deriveMasterKey(
  kdfInput: Uint8Array,
  salt: Uint8Array,
  params: ArgonParams = ARGON_PARAMS,
): Promise<Uint8Array> {
  if (kdfInput.length === 0) {
    throw new Error('deriveMasterKey: kdfInput is empty');
  }
  if (salt.length !== SALT_BYTES) {
    throw new Error(`deriveMasterKey: salt must be ${SALT_BYTES} bytes, got ${salt.length}`);
  }
  if (params.m < 8 || params.t < 1 || params.p < 1) {
    throw new Error('deriveMasterKey: Argon2id parameters are out of range');
  }

  return argon2id(kdfInput, salt, {
    m: params.m,
    t: params.t,
    p: params.p,
    dkLen: KEY_BYTES,
    version: ARGON_VERSION,
  });
}

/**
 * Derives one 32-byte subkey from the master key. The `info` label is the only
 * thing separating the auth, wrap and phantom branches, so it is a closed union.
 * Does not mutate or retain the master key.
 */
export async function deriveSubkey(masterKey: Uint8Array, info: SubkeyInfo): Promise<Uint8Array> {
  if (masterKey.length !== KEY_BYTES) {
    throw new Error(`deriveSubkey: masterKey must be ${KEY_BYTES} bytes, got ${masterKey.length}`);
  }
  // No HKDF salt: the master key is already the output of a salted, memory-hard KDF.
  return hkdf(sha256, masterKey, undefined, new TextEncoder().encode(info), KEY_BYTES);
}

/** Cryptographically secure random bytes. The only source of randomness in `core/crypto`. */
export function randomBytes(n: number): Uint8Array {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`randomBytes: length must be a positive integer, got ${n}`);
  }
  return crypto.getRandomValues(new Uint8Array(n));
}
