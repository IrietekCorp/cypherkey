import { eventsToTokens } from './script';
import type { FeatureExtractionError, FeatureVector, KeyEvent } from './types';

// A-4.2: the vector is 3*len + 5 — dwell[0..len-1], flight[0..len-2], digraph[0..len-2]
// (that is 3*len - 2) plus 7 globals [totalTime, meanDwell, stdDwell, meanFlight,
// stdFlight, meanDigraph, stdDigraph]. `len` counts script tokens, not characters.

/**
 * Computes the population standard deviation of an array of numbers.
 */
function populationStdDev(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  let sumSq = 0;
  for (const v of values) {
    const diff = v - mean;
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq / values.length);
}

/**
 * Computes the mean of an array of numbers.
 */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

/**
 * Feature weighting constants per specification A-4.4.
 */
export const FEATURE_WEIGHTS = {
  dwell: 1.0,
  flight: 1.5,
  digraph: 1.0,
  globals: 0.5,
} as const;

/**
 * Returns the index boundary ranges [start, end) for feature partitions of a given passphrase length.
 */
export function getFeatureRanges(len: number) {
  const dwellEnd = len;
  const flightEnd = dwellEnd + Math.max(0, len - 1);
  const digraphEnd = flightEnd + Math.max(0, len - 1);
  const globalsEnd = digraphEnd + 7;
  return {
    dwell: [0, dwellEnd] as const,
    flight: [dwellEnd, flightEnd] as const,
    digraph: [flightEnd, digraphEnd] as const,
    globals: [digraphEnd, globalsEnd] as const,
    totalLength: globalsEnd,
  };
}

/**
 * Extracts the fixed-order feature vector for a sample.
 *
 * Tokenization is not repeated here: `eventsToTokens` in `script.ts` is the single
 * definition of what counts as a keystroke (A-14.1), so a Backspace, a lone Escape
 * and a lone modifier tap are ordinary keys with ordinary timings. Backspace is no
 * longer rejected — it is a legitimate Phantom Key.
 */
export function extractFeatures(
  events: KeyEvent[],
  expectedLen: number,
): FeatureVector | FeatureExtractionError {
  if (expectedLen <= 0) {
    return { error: 'length_mismatch' };
  }

  const tokenized = eventsToTokens(events);
  if ('error' in tokenized) {
    return { error: tokenized.error };
  }

  const strokes = tokenized.tokens.map((t) => ({ key: t.token, downT: t.downT, upT: t.upT }));

  if (strokes.length !== expectedLen) {
    return { error: 'length_mismatch' };
  }

  // Sort strokes by keydown time to ensure correct sequential order
  strokes.sort((a, b) => a.downT - b.downT);

  // 3. Calculate Dwell times [0..len-1]
  const dwells: number[] = new Array(expectedLen);
  for (let i = 0; i < expectedLen; i++) {
    dwells[i] = strokes[i].upT - strokes[i].downT;
  }

  // 4. Calculate Flight times [0..len-2] and Digraph times [0..len-2]
  const flights: number[] = new Array(Math.max(0, expectedLen - 1));
  const digraphs: number[] = new Array(Math.max(0, expectedLen - 1));

  for (let i = 0; i < expectedLen - 1; i++) {
    flights[i] = strokes[i + 1].downT - strokes[i].upT;
    digraphs[i] = strokes[i + 1].downT - strokes[i].downT;
  }

  // 5. Calculate Globals: [totalTime, meanDwell, stdDwell, meanFlight, stdFlight, meanDigraph, stdDigraph]
  let minDown = strokes[0].downT;
  let maxUp = strokes[0].upT;
  for (let i = 1; i < expectedLen; i++) {
    if (strokes[i].downT < minDown) minDown = strokes[i].downT;
    if (strokes[i].upT > maxUp) maxUp = strokes[i].upT;
  }
  const totalTime = maxUp - minDown;

  const mDwell = mean(dwells);
  const sDwell = populationStdDev(dwells, mDwell);

  const mFlight = mean(flights);
  const sFlight = populationStdDev(flights, mFlight);

  const mDigraph = mean(digraphs);
  const sDigraph = populationStdDev(digraphs, mDigraph);

  const globals = [totalTime, mDwell, sDwell, mFlight, sFlight, mDigraph, sDigraph];

  const values = [...dwells, ...flights, ...digraphs, ...globals];

  return {
    version: 1,
    len: expectedLen,
    values,
  };
}
