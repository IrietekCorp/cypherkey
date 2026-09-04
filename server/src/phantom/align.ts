import { equalBytes } from '../../../core/crypto/encoding';

/** A-14.3: the DP table is O(n·m), so the sequences are bounded. */
export const MAX_SEQUENCE = 128;

export type AlignOp = {
  op: 'match' | 'sub' | 'ins' | 'del';
  /** Index in the enrolled (canonical) sequence, or null for an insertion. */
  canonIdx: number | null;
  /** Index in the login sequence, or null for a deletion. */
  loginIdx: number | null;
};

export type Alignment = {
  distance: number;
  /** Extra tokens in the login that the enrolled script does not have. */
  insertions: number;
  /** Enrolled tokens the login did not produce. This is what an attacker looks like. */
  deletions: number;
  substitutions: number;
  ops: AlignOp[];
  /** True when either sequence was longer than MAX_SEQUENCE and nothing was compared. */
  truncated: boolean;
};

/**
 * Levenshtein alignment between the enrolled commitment sequence and a login's,
 * with the path retained.
 *
 * Insertions, deletions and substitutions are counted separately and never collapsed
 * into one number. A-16 explains why: a fumbled key you correct is two insertions,
 * while someone typing only your leaked resolved passphrase is a deletion per
 * phantom. Under a single symmetric distance those are indistinguishable.
 */
export function alignCommitments(canonical: Uint8Array[], login: Uint8Array[]): Alignment {
  if (canonical.length > MAX_SEQUENCE || login.length > MAX_SEQUENCE) {
    return {
      distance: Number.POSITIVE_INFINITY,
      insertions: Number.POSITIVE_INFINITY,
      deletions: Number.POSITIVE_INFINITY,
      substitutions: Number.POSITIVE_INFINITY,
      ops: [],
      truncated: true,
    };
  }

  const n = canonical.length;
  const m = login.length;
  const width = m + 1;
  const cost = new Int32Array((n + 1) * width);

  for (let i = 0; i <= n; i++) cost[i * width] = i;
  for (let j = 0; j <= m; j++) cost[j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      // Commitments are compared in constant time; they are derived from a secret.
      const same = equalBytes(canonical[i - 1] as Uint8Array, login[j - 1] as Uint8Array);
      const substitute = (cost[(i - 1) * width + (j - 1)] as number) + (same ? 0 : 1);
      const remove = (cost[(i - 1) * width + j] as number) + 1;
      const insert = (cost[i * width + (j - 1)] as number) + 1;
      cost[i * width + j] = Math.min(substitute, remove, insert);
    }
  }

  // Walk back along the cheapest path. Ties prefer match, then substitution, then
  // deletion, so the path is deterministic for a given pair of sequences.
  const ops: AlignOp[] = [];
  let insertions = 0;
  let deletions = 0;
  let substitutions = 0;
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const same = equalBytes(canonical[i - 1] as Uint8Array, login[j - 1] as Uint8Array);
      const diagonal = (cost[(i - 1) * width + (j - 1)] as number) + (same ? 0 : 1);
      if ((cost[i * width + j] as number) === diagonal) {
        ops.push({ op: same ? 'match' : 'sub', canonIdx: i - 1, loginIdx: j - 1 });
        if (!same) substitutions++;
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && (cost[i * width + j] as number) === (cost[(i - 1) * width + j] as number) + 1) {
      ops.push({ op: 'del', canonIdx: i - 1, loginIdx: null });
      deletions++;
      i--;
      continue;
    }
    ops.push({ op: 'ins', canonIdx: null, loginIdx: j - 1 });
    insertions++;
    j--;
  }

  ops.reverse();
  return {
    distance: cost[n * width + m] as number,
    insertions,
    deletions,
    substitutions,
    ops,
    truncated: false,
  };
}
