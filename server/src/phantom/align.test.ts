import { describe, expect, spyOn, test } from 'bun:test';
import { extractFeatures } from '../../../core/biometrics/features';
import { buildProfile, score as coreScore } from '../../../core/biometrics/score';
import type { FeatureVector, KeyEvent } from '../../../core/biometrics/types';
import { scoreAligned } from '../biometrics/score';
import { MAX_SEQUENCE, alignCommitments } from './align';

/** Stand-in commitments: one byte per token, so a script reads as a string in a test. */
const commits = (script: string) => [...script].map((ch) => Uint8Array.from([ch.charCodeAt(0)]));

/** Token keys must be real printable characters now — A-14.1 rejects anything else. */
const keyAt = (i: number) => String.fromCharCode(97 + (i % 26));

/**
 * A sample typed at a steady cadence, with an optional per-token nudge, so the timing
 * of a given position can be varied without changing anything else.
 */
function sample(tokens: number, nudge: (i: number) => number = () => 0): FeatureVector {
  const events: KeyEvent[] = [];
  let t = 0;
  for (let i = 0; i < tokens; i++) {
    const dwell = 80 + nudge(i);
    events.push({ type: 'down', key: keyAt(i), t });
    events.push({ type: 'up', key: keyAt(i), t: t + dwell });
    t += 120;
  }
  const result = extractFeatures(events, tokens);
  if ('error' in result) throw new Error(result.error);
  return result;
}

/**
 * A sample with an extra keystroke wedged in after position `at`, costing `extraMs`
 * of wall clock beyond the normal gap. `extraMs: 0` is a fumble fast enough to fit
 * inside the rhythm the user already had; a real one costs tens of milliseconds.
 */
function sampleWithInsertion(tokens: number, at: number, extraMs = 0): FeatureVector {
  const events: KeyEvent[] = [];
  let t = 0;
  for (let i = 0; i < tokens; i++) {
    events.push({ type: 'down', key: keyAt(i), t });
    events.push({ type: 'up', key: keyAt(i), t: t + 80 });
    t += 120;
    if (i === at) {
      events.push({ type: 'down', key: 'Z', t });
      events.push({ type: 'up', key: 'Z', t: t + 40 });
      t += extraMs;
    }
  }
  const result = extractFeatures(events, tokens + 1);
  if ('error' in result) throw new Error(result.error);
  return result;
}

const profileOf = (v: FeatureVector, count = 8) =>
  buildProfile(Array.from({ length: count }, () => v));

describe('alignCommitments', () => {
  // (1)
  test('identical sequences align to all matches, with nothing counted', () => {
    const a = alignCommitments(commits('passw0rd'), commits('passw0rd'));
    expect(a).toMatchObject({ distance: 0, insertions: 0, deletions: 0, substitutions: 0 });
    expect(a.ops.every((o) => o.op === 'match')).toBe(true);
    expect(a.ops).toHaveLength(8);
  });

  // (2)
  test('a typo and its correction read as two insertions, never as deletions', () => {
    const a = alignCommitments(commits('passw0rd'), commits('passxZw0rd'));
    expect(a.insertions).toBe(2);
    expect(a.deletions).toBe(0);
    expect(a.substitutions).toBe(0);
  });

  // (3)
  test('a missing enrolled token is a deletion', () => {
    const a = alignCommitments(commits('passw0rd'), commits('passw0r'));
    expect(a.deletions).toBe(1);
    expect(a.insertions).toBe(0);
  });

  // (3b) The property the asymmetry exists for.
  test('typing only the resolved passphrase reads as one deletion per phantom', () => {
    // Canonical has two phantoms (S and Z) that the resolved text does not.
    const a = alignCommitments(commits('pasSZsw0rd'), commits('passw0rd'));
    expect(a.deletions).toBe(2);
    expect(a.insertions).toBe(0);
  });

  test('a changed token is a substitution, not an insert plus a delete', () => {
    const a = alignCommitments(commits('abc'), commits('axc'));
    expect(a).toMatchObject({ substitutions: 1, insertions: 0, deletions: 0 });
  });

  test('the ops cover every position of both sequences, in order', () => {
    const a = alignCommitments(commits('abcd'), commits('aXbcd'));
    const canon = a.ops.filter((o) => o.canonIdx !== null).map((o) => o.canonIdx);
    const login = a.ops.filter((o) => o.loginIdx !== null).map((o) => o.loginIdx);
    expect(canon).toEqual([0, 1, 2, 3]);
    expect(login).toEqual([0, 1, 2, 3, 4]);
  });

  test('an empty login is all deletions, and an empty canonical is all insertions', () => {
    expect(alignCommitments(commits('abc'), [])).toMatchObject({ deletions: 3, insertions: 0 });
    expect(alignCommitments([], commits('abc'))).toMatchObject({ insertions: 3, deletions: 0 });
  });

  test('is deterministic for a given pair', () => {
    const a = alignCommitments(commits('abcabc'), commits('abcxabc'));
    const b = alignCommitments(commits('abcabc'), commits('abcxabc'));
    expect(a.ops).toEqual(b.ops);
  });

  test('refuses a sequence past the bound rather than building a huge table', () => {
    const huge = Array.from({ length: MAX_SEQUENCE + 1 }, () => new Uint8Array([1]));
    const a = alignCommitments(huge, commits('abc'));
    expect(a.truncated).toBe(true);
    // Infinite counts cannot fit any budget, so an oversized sequence fails closed.
    expect(a.insertions).toBe(Number.POSITIVE_INFINITY);
    expect(a.deletions).toBe(Number.POSITIVE_INFINITY);
  });

  test('compares whole commitments, not just their first byte', () => {
    const a = [Uint8Array.from([1, 2, 3, 4])];
    const b = [Uint8Array.from([1, 2, 3, 5])];
    expect(alignCommitments(a, b).substitutions).toBe(1);
    expect(alignCommitments(a, a).distance).toBe(0);
  });
});

describe('scoreAligned', () => {
  test('with no alignment it agrees with core scoring exactly', () => {
    const enrolled = sample(12);
    const profile = profileOf(enrolled);
    const other = sample(12, (i) => (i % 3) * 9);

    expect(scoreAligned(profile, enrolled)).toBeCloseTo(coreScore(profile, enrolled), 12);
    expect(scoreAligned(profile, other)).toBeCloseTo(coreScore(profile, other), 12);
  });

  test('an all-match alignment changes nothing', () => {
    const enrolled = sample(12);
    const profile = profileOf(enrolled);
    const alignment = alignCommitments(commits('abcdefghijkl'), commits('abcdefghijkl'));
    expect(scoreAligned(profile, enrolled, alignment)).toBeCloseTo(
      scoreAligned(profile, enrolled),
      12,
    );
  });

  // (4) — the ticket's 0.02 holds when the stray keystroke costs no extra time, which
  // is the only case where bridging is exact. See the test below for the general one.
  test('a 13-token login whose stray key fits inside the rhythm scores within 0.02', () => {
    const enrolled = sample(12);
    const profile = profileOf(enrolled);
    const baseline = scoreAligned(profile, enrolled);

    const withStray = sampleWithInsertion(12, 5, 0);
    expect(withStray.len).toBe(13);
    const alignment = alignCommitments(commits('abcdefghijkl'), commits('abcdefXghijkl'));
    expect(alignment.insertions).toBe(1);

    const aligned = scoreAligned(profile, withStray, alignment);
    expect(Math.abs(aligned - baseline)).toBeLessThanOrEqual(0.02);
  });

  /**
   * The general case, measured rather than assumed. Bridging recomputes the gap that
   * spans the dropped token from the real neighbours, so a fumble that took time shows
   * up as a longer gap — which is exactly right, because the rhythm really was
   * disturbed. The cost is therefore proportional to how long the fumble took, and is
   * not bounded by a constant.
   */
  test('a fumble that takes time costs score in proportion, monotonically', () => {
    const enrolled = sample(12);
    const profile = profileOf(enrolled);
    const baseline = scoreAligned(profile, enrolled);
    const alignment = alignCommitments(commits('abcdefghijkl'), commits('abcdefXghijkl'));

    let previous = -1;
    for (const extra of [0, 20, 40, 60, 100, 150]) {
      const deviation = Math.abs(
        scoreAligned(profile, sampleWithInsertion(12, 5, extra), alignment) - baseline,
      );
      expect(deviation).toBeGreaterThanOrEqual(previous);
      previous = deviation;
    }
    // Even the slowest fumble here stays well inside the Medium pass band.
    expect(previous).toBeLessThan(0.12);
  });

  test('a corrected typo still clears the Medium pass band from a realistic baseline', () => {
    // A real user does not score 1.0; enrol from samples that vary a little.
    const profile = buildProfile(
      [0, 4, 8, 6, 2, 10, 5, 3].map((j) => sample(12, (i) => ((i + j) % 5) * j)),
    );
    const clean = scoreAligned(
      profile,
      sample(12, (i) => (i % 5) * 4),
    );
    const alignment = alignCommitments(commits('abcdefghijkl'), commits('abcdefXghijkl'));
    const fumbled = scoreAligned(profile, sampleWithInsertion(12, 5, 60), alignment);

    expect(clean).toBeGreaterThan(0.62);
    expect(fumbled).toBeGreaterThan(0.62);
  });

  // (4b)
  test('a deletion costs more than an insertion, but stays within 0.06', () => {
    const enrolled = sample(12);
    const profile = profileOf(enrolled);
    const baseline = scoreAligned(profile, enrolled);

    const short = sample(11);
    const alignment = alignCommitments(commits('abcdefghijkl'), commits('abcdefghijk'));
    expect(alignment.deletions).toBe(1);

    const aligned = scoreAligned(profile, short, alignment);
    expect(Math.abs(aligned - baseline)).toBeLessThanOrEqual(0.06);
  });

  /**
   * Bridging keeps the evidence that spans an insertion; neutralizing would throw it
   * away and score higher for it. That makes bridging the stricter rule, not the more
   * forgiving one, which is the opposite of what "nothing is neutralized" suggests.
   * The test pins the direction: a fumble that cost real time must not score as well
   * as one that cost none.
   */
  test('bridging keeps the timing evidence rather than discarding it', () => {
    const profile = profileOf(sample(12));
    const alignment = alignCommitments(commits('abcdefghijkl'), commits('abcdefXghijkl'));

    const free = scoreAligned(profile, sampleWithInsertion(12, 5, 0), alignment);
    const slow = scoreAligned(profile, sampleWithInsertion(12, 5, 100), alignment);
    expect(slow).toBeLessThan(free);
  });

  test('a genuinely different rhythm still scores low through an alignment', () => {
    const profile = profileOf(sample(12));
    const stranger = sample(12, (i) => 90 + i * 12);
    const alignment = alignCommitments(commits('abcdefghijkl'), commits('abcdefghijkl'));
    expect(scoreAligned(profile, stranger, alignment)).toBeLessThan(0.45);
  });

  test('the score stays inside 0 and 1 whatever the alignment', () => {
    const profile = profileOf(sample(12));
    for (const login of ['abcdefghijkl', 'abcdefXghijkl', 'abcdefghijk', 'ab', '']) {
      const alignment = alignCommitments(commits('abcdefghijkl'), commits(login));
      const s = scoreAligned(profile, sample(Math.max(1, login.length)), alignment);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

// (5)
describe('nothing about a script reaches a log', () => {
  test('no commitment, token or vector is written to the console', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const profile = profileOf(sample(12));
      const alignment = alignCommitments(commits('abcdefghijkl'), commits('abcdefXghijkl'));
      scoreAligned(profile, sampleWithInsertion(12, 5, 60), alignment);
      alignCommitments(commits('abc'), commits('abd'));
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  test('the alignment result carries indices and counts, never commitment bytes', () => {
    const alignment = alignCommitments(commits('secret'), commits('secXret'));
    const serialized = JSON.stringify(alignment);
    expect(serialized).not.toContain('secret');
    for (const op of alignment.ops) {
      expect(Object.keys(op).sort()).toEqual(['canonIdx', 'loginIdx', 'op']);
    }
  });
});
