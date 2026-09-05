import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { utf8Encode } from './encoding';
import { KEY_BYTES, randomBytes } from './kdf';

/** 160 bits of entropy, which is 32 Crockford base32 symbols exactly. */
export const RECOVERY_SECRET_BYTES = 20;

/** Crockford base32: no I, L, O or U, so nothing is confusable when read aloud or retyped. */
const DATA_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford's check symbol extends the alphabet to 37 values, and 37 is prime. */
const CHECK_ALPHABET = `${DATA_ALPHABET}*~$=U`;

const DATA_SYMBOLS = 32;
const GROUP_SIZE = 4;

/** HKDF label separating the Recovery Kit branch from every other key in A-2. */
const RECOVERY_INFO = 'cypherkey/recovery/v1';
/** A-2: the branch that *proves possession*, kept separate from the one that unwraps. */
const RECOVERY_AUTH_INFO = 'cypherkey/recovery-auth/v1';

/** Decoding table, including Crockford's aliases: O reads as 0, I and L read as 1. */
const DECODE = (() => {
  const table = new Map<string, number>();
  for (let i = 0; i < DATA_ALPHABET.length; i++) {
    table.set(DATA_ALPHABET[i] as string, i);
  }
  table.set('O', 0);
  table.set('I', 1);
  table.set('L', 1);
  return table;
})();

/** Rejections say what is wrong without ever echoing the code, which is a secret. */
class RecoveryCodeError extends Error {
  override readonly name = 'RecoveryCodeError';
}

/** Crockford's check value: the whole secret read as one big-endian integer, mod 37. */
function checkValue(secret: Uint8Array): number {
  let remainder = 0;
  for (const byte of secret) {
    remainder = (remainder * 256 + byte) % 37;
  }
  return remainder;
}

/**
 * Renders a 20-byte secret as its 32 data symbols plus one check symbol, hyphenated
 * into groups of four for transcription. The check symbol rides on the final group.
 */
export function formatRecoveryCode(secret: Uint8Array): string {
  if (secret.length !== RECOVERY_SECRET_BYTES) {
    throw new RecoveryCodeError(
      `recovery code secret must be ${RECOVERY_SECRET_BYTES} bytes, got ${secret.length}`,
    );
  }

  let symbols = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of secret) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      symbols += DATA_ALPHABET[(buffer >>> bits) & 31];
    }
  }

  const groups: string[] = [];
  for (let i = 0; i < DATA_SYMBOLS; i += GROUP_SIZE) {
    groups.push(symbols.slice(i, i + GROUP_SIZE));
  }
  const last = groups.length - 1;
  groups[last] = `${groups[last]}${CHECK_ALPHABET[checkValue(secret)]}`;
  return groups.join('-');
}

/**
 * Parses a Recovery Kit code back to its 20-byte secret. Hyphens, whitespace and case
 * are ignored, and Crockford's aliases are accepted, because this is typed off paper.
 * Throws if the check symbol does not match — which catches every single-symbol typo
 * and every adjacent transposition.
 */
export function parseRecoveryCode(code: string): Uint8Array {
  const cleaned = code.replace(/[\s-]/g, '').toUpperCase();
  if (cleaned.length !== DATA_SYMBOLS + 1) {
    throw new RecoveryCodeError(
      `recovery code must be ${DATA_SYMBOLS + 1} symbols, got ${cleaned.length}`,
    );
  }

  const secret = new Uint8Array(RECOVERY_SECRET_BYTES);
  let written = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < DATA_SYMBOLS; i++) {
    const value = DECODE.get(cleaned[i] as string);
    if (value === undefined) {
      throw new RecoveryCodeError(
        `recovery code contains a symbol that is not valid at position ${i + 1}`,
      );
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      secret[written++] = (buffer >>> bits) & 0xff;
    }
  }

  const expected = CHECK_ALPHABET[checkValue(secret)];
  if (cleaned[DATA_SYMBOLS] !== expected) {
    secret.fill(0);
    throw new RecoveryCodeError('recovery code check symbol does not match — it was mistyped');
  }
  return secret;
}

/** Generates a fresh Recovery Kit code. Shown once, never stored (X-2 step 3). */
export function generateRecoveryCode(): string {
  return formatRecoveryCode(randomBytes(RECOVERY_SECRET_BYTES));
}

/**
 * Derives the 32-byte key that wraps `recoveryWrappedVaultKey`. HKDF rather than
 * Argon2id because the input is already 160 uniform random bits, not a passphrase.
 */
export async function recoveryKeyFromCode(code: string): Promise<Uint8Array> {
  const secret = parseRecoveryCode(code);
  try {
    return hkdf(sha256, secret, undefined, utf8Encode(RECOVERY_INFO), KEY_BYTES);
  } finally {
    secret.fill(0);
  }
}

/**
 * The verifier the server stores, so that the value proving possession of the Kit is
 * never the value that unwraps the vault.
 *
 * Chained off `recoveryKey` rather than derived as its sibling purely to reuse the
 * tested `recoveryKeyFromCode()`. HKDF is one-way either way, so a stolen verifier
 * reveals nothing about the wrap key: an attacker holding `recoveryAuthHash` still
 * cannot decrypt `recoveryWrappedVaultKey`.
 *
 * The server stores `Argon2id(recoveryAuthHash)`, exactly as it stores `Argon2id(authHash)`.
 */
export async function recoveryAuthHashFromKey(recoveryKey: Uint8Array): Promise<Uint8Array> {
  return hkdf(sha256, recoveryKey, undefined, utf8Encode(RECOVERY_AUTH_INFO), KEY_BYTES);
}
