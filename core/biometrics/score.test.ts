import { describe, expect, it } from 'bun:test';
import { getFeatureRanges } from './features';
import { type Profile, adapt, band, buildProfile, score } from './score';
import type { FeatureVector } from './types';

function createSample(values: number[], len = 6): FeatureVector {
  return {
    version: 1,
    len,
    values,
  };
}

describe('core/biometrics/score', () => {
  const totalLength6 = getFeatureRanges(6).totalLength; // 23 features

  describe('buildProfile', () => {
    it('throws when samples array is empty', () => {
      expect(() => buildProfile([])).toThrow('Cannot build profile with empty samples');
    });

    it('throws when samples have mismatched passphrase lengths', () => {
      const s1 = createSample(new Array(totalLength6).fill(100), 6);
      const s2 = createSample(new Array(getFeatureRanges(7).totalLength).fill(100), 7);
      expect(() => buildProfile([s1, s2])).toThrow(
        'All samples must have the same passphrase length',
      );
    });

    it('throws when sample values length does not match expected length', () => {
      const s1 = createSample(new Array(totalLength6).fill(100), 6);
      const s2: FeatureVector = { version: 1, len: 6, values: [1, 2, 3] };
      expect(() => buildProfile([s1, s2])).toThrow(
        'Sample feature vector length does not match passphrase length',
      );
    });

    it('requirement 5: profile from 8 near-identical samples has all stds == 8 (flooring check)', () => {
      const samples = Array.from({ length: 8 }, (_, i) =>
        createSample(new Array(totalLength6).fill(100 + (i % 2)), 6),
      );

      const profile = buildProfile(samples);

      expect(profile.version).toBe(1);
      expect(profile.len).toBe(6);
      expect(profile.sampleCount).toBe(8);
      expect(profile.means.length).toBe(totalLength6);
      expect(profile.stds.length).toBe(totalLength6);
      expect(profile.weights.length).toBe(totalLength6);

      // Unfloored std dev of [100, 101, 100, 101, ...] is 0.5, floored to 8
      for (const std of profile.stds) {
        expect(std).toBe(8);
      }

      for (const mean of profile.means) {
        expect(mean).toBe(100.5);
      }
    });

    it('assigns correct weights per feature category', () => {
      const samples = Array.from({ length: 8 }, () =>
        createSample(new Array(totalLength6).fill(50), 6),
      );
      const profile = buildProfile(samples);
      const ranges = getFeatureRanges(6);

      // dwell = 1.0
      for (let i = ranges.dwell[0]; i < ranges.dwell[1]; i++) {
        expect(profile.weights[i]).toBe(1.0);
      }
      // flight = 1.5
      for (let i = ranges.flight[0]; i < ranges.flight[1]; i++) {
        expect(profile.weights[i]).toBe(1.5);
      }
      // digraph = 1.0
      for (let i = ranges.digraph[0]; i < ranges.digraph[1]; i++) {
        expect(profile.weights[i]).toBe(1.0);
      }
      // globals = 0.5
      for (let i = ranges.globals[0]; i < ranges.globals[1]; i++) {
        expect(profile.weights[i]).toBe(0.5);
      }
    });

    it('does not persist raw samples or feature vectors in profile object', () => {
      const samples = Array.from({ length: 5 }, () =>
        createSample(new Array(totalLength6).fill(100), 6),
      );
      const profile = buildProfile(samples);
      const keys = Object.keys(profile).sort();
      expect(keys).toEqual(['len', 'means', 'sampleCount', 'stds', 'version', 'weights']);
    });
  });

  describe('score', () => {
    function buildMockProfile(): Profile {
      const ranges = getFeatureRanges(6);
      const weights = new Array<number>(ranges.totalLength);
      for (let i = ranges.dwell[0]; i < ranges.dwell[1]; i++) weights[i] = 1.0;
      for (let i = ranges.flight[0]; i < ranges.flight[1]; i++) weights[i] = 1.5;
      for (let i = ranges.digraph[0]; i < ranges.digraph[1]; i++) weights[i] = 1.0;
      for (let i = ranges.globals[0]; i < ranges.globals[1]; i++) weights[i] = 0.5;

      return {
        version: 1,
        len: 6,
        sampleCount: 8,
        means: new Array(ranges.totalLength).fill(100),
        stds: new Array(ranges.totalLength).fill(10),
        weights,
      };
    }

    it('requirement 1: a sample equal to the means scores >= 0.99', () => {
      const profile = buildMockProfile();
      const sample = createSample(new Array(profile.means.length).fill(100), 6);
      const s = score(profile, sample);
      expect(s).toBeGreaterThanOrEqual(0.99);
      expect(s).toBe(1.0);
    });

    it('requirement 2: a sample 3 std away on all features scores < 0.35', () => {
      const profile = buildMockProfile();
      // 3 std away on all features: x = 100 + 3 * 10 = 130
      const sample = createSample(new Array(profile.means.length).fill(130), 6);
      const s = score(profile, sample);

      // Theoretical: z = 3, k = 2, featureScore = 1 / (1 + (3/2)^2) = 1 / 3.25 = 0.3076923...
      const expected = 1 / (1 + (3 / 2) ** 2);
      expect(s).toBeLessThan(0.35);
      expect(s).toBeCloseTo(expected, 5);
    });

    it('throws when sample length does not match profile length', () => {
      const profile = buildMockProfile();
      const sampleWrongLen = createSample(new Array(totalLength6).fill(100), 5);
      expect(() => score(profile, sampleWrongLen)).toThrow('Sample length mismatch');

      const sampleWrongValuesLen = { version: 1 as const, len: 6, values: [100, 100] };
      expect(() => score(profile, sampleWrongValuesLen)).toThrow('Sample length mismatch');
    });
  });

  describe('band', () => {
    it('requirement 3: band thresholds (>= 0.62 pass, 0.45..0.62 grey, < 0.45 fail)', () => {
      expect(band(0.62)).toBe('pass');
      expect(band(0.7)).toBe('pass');
      expect(band(1.0)).toBe('pass');

      expect(band(0.619999)).toBe('grey');
      expect(band(0.55)).toBe('grey');
      expect(band(0.45)).toBe('grey');

      expect(band(0.449999)).toBe('fail');
      expect(band(0.3)).toBe('fail');
      expect(band(0.0)).toBe('fail');
    });

    it('supports custom pass and grey thresholds', () => {
      expect(band(0.75, 0.8, 0.6)).toBe('grey');
      expect(band(0.85, 0.8, 0.6)).toBe('pass');
      expect(band(0.59, 0.8, 0.6)).toBe('fail');
    });
  });

  describe('adapt', () => {
    function buildMockProfile(): Profile {
      return {
        version: 1,
        len: 6,
        sampleCount: 8,
        means: [100, 200, 300],
        stds: [8, 10, 12],
        weights: [1.0, 1.5, 0.5],
      };
    }

    it('requirement 4: adapt moves means by exactly alpha * (x - mean)', () => {
      const profile = buildMockProfile();
      const sample: FeatureVector = {
        version: 1,
        len: 6,
        values: [150, 220, 260],
      };

      const alpha = 0.1;
      const updated = adapt(profile, sample, alpha);

      // mean 0: 100 + 0.1 * (150 - 100) = 105
      // mean 1: 200 + 0.1 * (220 - 200) = 202
      // mean 2: 300 + 0.1 * (260 - 300) = 296
      expect(updated.means[0]).toBeCloseTo(105, 5);
      expect(updated.means[1]).toBeCloseTo(202, 5);
      expect(updated.means[2]).toBeCloseTo(296, 5);

      // preserves stds, weights, len, version and increments sampleCount
      expect(updated.stds).toEqual(profile.stds);
      expect(updated.weights).toEqual(profile.weights);
      expect(updated.len).toBe(profile.len);
      expect(updated.version).toBe(profile.version);
      expect(updated.sampleCount).toBe(profile.sampleCount + 1);

      // Immutability check: original profile must not be mutated
      expect(profile.means).toEqual([100, 200, 300]);
      expect(profile.sampleCount).toBe(8);
    });

    it('throws when sample vector length does not match profile means length', () => {
      const profile = buildMockProfile();
      const invalidSample: FeatureVector = {
        version: 1,
        len: 6,
        values: [100],
      };
      expect(() => adapt(profile, invalidSample)).toThrow('Sample length mismatch');
    });
  });
});
