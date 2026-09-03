import { FEATURE_WEIGHTS, getFeatureRanges } from './features';
import type { FeatureVector } from './types';

export type Profile = {
  version: 1;
  len: number;
  means: number[];
  stds: number[];
  weights: number[];
  sampleCount: number;
};

/**
 * Builds an aggregate biometric profile from enrollment feature vectors with standard deviations floored at 8 ms.
 */
export function buildProfile(samples: FeatureVector[]): Profile {
  const first = samples[0];
  if (!first || samples.length === 0) {
    throw new Error('Cannot build profile with empty samples');
  }

  const len = first.len;
  const ranges = getFeatureRanges(len);
  const expectedVectorLen = ranges.totalLength;

  for (const sample of samples) {
    if (sample.len !== len) {
      throw new Error('All samples must have the same passphrase length');
    }
    if (sample.values.length !== expectedVectorLen) {
      throw new Error('Sample feature vector length does not match passphrase length');
    }
  }

  const sampleCount = samples.length;
  const means = new Array<number>(expectedVectorLen);
  const stds = new Array<number>(expectedVectorLen);

  for (let i = 0; i < expectedVectorLen; i++) {
    let sum = 0;
    for (let s = 0; s < sampleCount; s++) {
      const sample = samples[s];
      const val = sample?.values[i];
      if (val !== undefined) {
        sum += val;
      }
    }
    const mean = sum / sampleCount;

    let sumSq = 0;
    for (let s = 0; s < sampleCount; s++) {
      const sample = samples[s];
      const val = sample?.values[i];
      if (val !== undefined) {
        const diff = val - mean;
        sumSq += diff * diff;
      }
    }
    const std = Math.sqrt(sumSq / sampleCount);

    means[i] = mean;
    stds[i] = Math.max(std, 8);
  }

  const weights = new Array<number>(expectedVectorLen);
  for (let i = ranges.dwell[0]; i < ranges.dwell[1]; i++) {
    weights[i] = FEATURE_WEIGHTS.dwell;
  }
  for (let i = ranges.flight[0]; i < ranges.flight[1]; i++) {
    weights[i] = FEATURE_WEIGHTS.flight;
  }
  for (let i = ranges.digraph[0]; i < ranges.digraph[1]; i++) {
    weights[i] = FEATURE_WEIGHTS.digraph;
  }
  for (let i = ranges.globals[0]; i < ranges.globals[1]; i++) {
    weights[i] = FEATURE_WEIGHTS.globals;
  }

  return {
    version: 1,
    len,
    means,
    stds,
    weights,
    sampleCount,
  };
}

/**
 * Computes the weighted biometric similarity score between 0 and 1 for a feature vector against a profile.
 */
export function score(profile: Profile, sample: FeatureVector): number {
  if (sample.len !== profile.len || sample.values.length !== profile.means.length) {
    throw new Error('Sample length mismatch');
  }

  const k = 2.0;
  let totalWeightedScore = 0;
  let totalWeight = 0;

  for (let i = 0; i < profile.means.length; i++) {
    const x = sample.values[i];
    const mean = profile.means[i];
    const std = profile.stds[i];
    const weight = profile.weights[i];

    if (x === undefined || mean === undefined || std === undefined || weight === undefined) {
      continue;
    }

    const z = Math.abs(x - mean) / std;
    const featureScore = 1 / (1 + (z / k) ** 2);
    totalWeightedScore += featureScore * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) {
    return 0;
  }

  return totalWeightedScore / totalWeight;
}

/**
 * Classifies a similarity score into 'pass', 'grey', or 'fail' decision bands based on thresholds.
 */
export function band(s: number, pass = 0.62, grey = 0.45): 'pass' | 'grey' | 'fail' {
  if (s >= pass) {
    return 'pass';
  }
  if (s >= grey) {
    return 'grey';
  }
  return 'fail';
}

/**
 * Adjusts profile means toward an authenticated sample via exponential moving average while preserving other parameters.
 */
export function adapt(profile: Profile, sample: FeatureVector, alpha = 0.1): Profile {
  if (sample.len !== profile.len || sample.values.length !== profile.means.length) {
    throw new Error('Sample length mismatch');
  }

  const newMeans = new Array<number>(profile.means.length);
  for (let i = 0; i < profile.means.length; i++) {
    const mean = profile.means[i];
    const x = sample.values[i];
    if (mean === undefined || x === undefined) {
      continue;
    }
    newMeans[i] = mean + alpha * (x - mean);
  }

  return {
    version: 1,
    len: profile.len,
    means: newMeans,
    stds: [...profile.stds],
    weights: [...profile.weights],
    sampleCount: profile.sampleCount + 1,
  };
}
