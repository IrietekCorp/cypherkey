import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { concatBytes, utf8Encode } from './encoding';

/** A-16. Medium is the default; Strict is the only level that folds the script into the KDF. */
export type Strictness = 'strict' | 'medium' | 'relaxed';

/** A-14.2: each commitment is a 16-byte truncation of an HMAC-SHA256. */
export const COMMITMENT_BYTES = 16;

/** The separator between the resolved passphrase and the script in Strict mode. */
const KDF_SEPARATOR = new Uint8Array([0x00]);

/**
 * How much a login may differ from the enrolled script (A-16).
 *
 * Insertions and deletions are budgeted separately, and that asymmetry is the whole
 * design: a fumbled key you then correct is two *insertions*, while an attacker who
 * holds your leaked passphrase and types only that is two *deletions*. Under a single
 * symmetric distance those are the same number, so any threshold forgiving the first
 * admits the second.
 */
export type Budget = { maxInsertions: number; maxMissing: number };

/**
 * Bytes fed to Argon2id (A-14.2).
 *
 * In Medium and Relaxed this is the resolved passphrase alone, so the script is
 * verified separately through commitments. In Strict the script is folded in, which
 * is what makes the phantoms protect the vault even against someone holding both a
 * database dump and the resolved passphrase.
 *
 * A wrong resolved passphrase therefore fails in every mode.
 */
export function kdfInput(resolved: string, script: string, level: Strictness): Uint8Array {
  const resolvedBytes = utf8Encode(resolved);
  if (level !== 'strict') return resolvedBytes;
  return concatBytes(resolvedBytes, KDF_SEPARATOR, utf8Encode(script));
}

/**
 * One commitment per script token, in order (A-14.2).
 *
 * The server stores these and compares them at login; it cannot recover a token,
 * because that needs `phantomKey`, which needs `masterKey`, which needs the
 * passphrase. What it can see is the *equality pattern* — repeated tokens commit
 * identically — and that is the disclosed leak, not an oversight. It reveals no
 * token identity and no position of a phantom relative to the resolved text.
 */
export async function scriptCommitments(
  phantomKey: Uint8Array,
  script: string,
): Promise<Uint8Array[]> {
  const commitments: Uint8Array[] = [];
  for (const token of script) {
    commitments.push(hmac(sha256, phantomKey, utf8Encode(token)).slice(0, COMMITMENT_BYTES));
  }
  return commitments;
}

/** The A-16 budget for a level, given the length of the enrolled script. */
export function budget(level: Strictness, canonLen: number): Budget {
  switch (level) {
    case 'strict':
      return { maxInsertions: 0, maxMissing: 0 };
    case 'medium':
      // One typo-and-correct is two insertions, so the floor is 2. Nothing missing is
      // ever forgiven at Medium: a missing token is what an attacker looks like.
      return { maxInsertions: Math.max(2, Math.floor(canonLen / 6)), maxMissing: 0 };
    case 'relaxed':
      // Relaxed forgives one missing token, which means a Relaxed user with fewer than
      // two phantoms gets no phantom protection at all. A-16 says to say so on screen.
      return { maxInsertions: Math.max(4, Math.floor(canonLen / 3)), maxMissing: 1 };
  }
}

/**
 * The rhythm pass and grey bands for a level (A-16). Kept beside the tolerance half of
 * the same table so the two cannot drift apart — A-16 is one control, not two.
 */
export function rhythmBands(level: Strictness): { pass: number; grey: number } {
  switch (level) {
    case 'strict':
      return { pass: 0.7, grey: 0.55 };
    case 'medium':
      return { pass: 0.62, grey: 0.45 };
    case 'relaxed':
      return { pass: 0.55, grey: 0.4 };
  }
}
