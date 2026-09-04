import { FEATURE_WEIGHTS, getFeatureRanges } from '../../../core/biometrics/features';
import type { Profile } from '../../../core/biometrics/score';
import type { FeatureVector } from '../../../core/biometrics/types';
import type { Alignment } from '../phantom/align';

/** A-4.4: featureScore = 1 / (1 + (z/k)^2). */
const K = 2.0;
/** A-14.3: a canonical position the login never produced scores neutrally, at half weight. */
const MISSING_SCORE = 0.5;
const MISSING_WEIGHT_FACTOR = 0.5;

type Timing = { downT: number; upT: number } | null;

/**
 * Recovers the down/up sequence from a feature vector.
 *
 * The server never receives raw timings, and it does not need them: `digraph[i]` is
 * `down[i+1] − down[i]` and `dwell[i]` is `up[i] − down[i]`, so the whole sequence
 * follows from an arbitrary origin. (`flight[i]` is `digraph[i] − dwell[i]`, which is
 * why it carries no independent information.) This is what makes A-14.3's "recompute
 * from the retained neighbours" implementable without weakening what the client sends.
 */
function timingsFrom(sample: FeatureVector): Array<{ downT: number; upT: number }> {
  const ranges = getFeatureRanges(sample.len);
  const dwell = sample.values.slice(...ranges.dwell);
  const digraph = sample.values.slice(...ranges.digraph);

  const timings: Array<{ downT: number; upT: number }> = [];
  let downT = 0;
  for (let i = 0; i < sample.len; i++) {
    timings.push({ downT, upT: downT + (dwell[i] as number) });
    downT += (digraph[i] as number) ?? 0;
  }
  return timings;
}

/**
 * Lays the login's tokens onto the enrolled script's positions, per A-14.3 step 4.
 *
 * Insertions are simply not placed, which *is* the bridge: the flight and digraph
 * between the surviving neighbours are then computed from their own timings and span
 * the dropped token, so nothing is neutralized and a stray keystroke perturbs two
 * values instead of four. Deletions leave a hole, scored neutrally later.
 */
function alignTimings(sample: FeatureVector, alignment: Alignment, canonLen: number): Timing[] {
  const source = timingsFrom(sample);
  const aligned: Timing[] = new Array(canonLen).fill(null);
  for (const op of alignment.ops) {
    if (op.canonIdx === null || op.loginIdx === null) continue;
    aligned[op.canonIdx] = source[op.loginIdx] ?? null;
  }
  return aligned;
}

/** Builds the `3n + 5` vector for the aligned token set, with holes marked. */
function alignedVector(aligned: Timing[]): { values: Array<number | null> } {
  const n = aligned.length;
  const dwell: Array<number | null> = [];
  const flight: Array<number | null> = [];
  const digraph: Array<number | null> = [];

  for (let i = 0; i < n; i++) {
    const t = aligned[i];
    dwell.push(t === null ? null : t.upT - t.downT);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = aligned[i];
    const b = aligned[i + 1];
    // A-14.3: a deletion neutralizes both pairs that touch it.
    flight.push(a === null || b === null ? null : b.downT - a.upT);
    digraph.push(a === null || b === null ? null : b.downT - a.downT);
  }

  const present = aligned.filter((t): t is { downT: number; upT: number } => t !== null);
  const known = (xs: Array<number | null>) => xs.filter((x): x is number => x !== null);
  const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  const std = (xs: number[], m: number) =>
    xs.length === 0 ? 0 : Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);

  // Globals come from the aligned token set, so both sides of the comparison describe
  // the same n positions even though the login had a different number of keystrokes.
  const totalTime =
    present.length === 0
      ? 0
      : Math.max(...present.map((t) => t.upT)) - Math.min(...present.map((t) => t.downT));
  const dw = known(dwell);
  const fl = known(flight);
  const dg = known(digraph);
  const mDwell = mean(dw);
  const mFlight = mean(fl);
  const mDigraph = mean(dg);

  return {
    values: [
      ...dwell,
      ...flight,
      ...digraph,
      totalTime,
      mDwell,
      std(dw, mDwell),
      mFlight,
      std(fl, mFlight),
      mDigraph,
      std(dg, mDigraph),
    ],
  };
}

/** The A-4.4 weight for a feature index, given the layout for `len` tokens. */
function weightAt(index: number, len: number): number {
  const r = getFeatureRanges(len);
  if (index < r.dwell[1]) return FEATURE_WEIGHTS.dwell;
  if (index < r.flight[1]) return FEATURE_WEIGHTS.flight;
  if (index < r.digraph[1]) return FEATURE_WEIGHTS.digraph;
  return FEATURE_WEIGHTS.globals;
}

/**
 * Scores a sample against a profile, optionally through an alignment path (A-14.3).
 *
 * Without an alignment this is A-4.4 unchanged, and a test asserts it agrees with
 * `core/biometrics/score` exactly so the two cannot drift.
 */
export function scoreAligned(
  profile: Profile,
  sample: FeatureVector,
  alignment?: Alignment,
): number {
  const expected = getFeatureRanges(profile.len).totalLength;
  if (profile.means.length !== expected) {
    throw new Error('Profile length mismatch');
  }

  let values: Array<number | null>;
  if (alignment === undefined) {
    if (sample.len !== profile.len || sample.values.length !== expected) {
      throw new Error('Sample length mismatch');
    }
    values = sample.values;
  } else {
    values = alignedVector(alignTimings(sample, alignment, profile.len)).values;
  }

  let weighted = 0;
  let total = 0;
  for (let i = 0; i < expected; i++) {
    const mean = profile.means[i];
    const std = profile.stds[i];
    const weight = profile.weights[i] ?? weightAt(i, profile.len);
    if (mean === undefined || std === undefined) continue;

    const x = values[i];
    if (x === null || x === undefined) {
      weighted += MISSING_SCORE * weight * MISSING_WEIGHT_FACTOR;
      total += weight * MISSING_WEIGHT_FACTOR;
      continue;
    }

    const z = Math.abs(x - mean) / std;
    weighted += (1 / (1 + (z / K) ** 2)) * weight;
    total += weight;
  }

  return total === 0 ? 0 : weighted / total;
}
