/**
 * Raw key event captured during passphrase entry.
 * Timestamp t is high-resolution (e.g. performance.now()).
 */
export type KeyEvent = {
  key: string;
  type: 'down' | 'up';
  t: number;
};

/**
 * Fixed-order biometric feature vector for a passphrase of length len.
 * Total vector length is 3*len + 5 per A-4.2:
 * - dwell[0..len-1] (len items)
 * - flight[0..len-2] (len-1 items)
 * - digraph[0..len-2] (len-1 items)
 * - globals (7 items): [totalTime, meanDwell, stdDwell, meanFlight, stdFlight, meanDigraph, stdDigraph]
 */
export type FeatureVector = {
  version: 1;
  len: number;
  values: number[];
};

export type FeatureExtractionError = {
  error: 'backspace' | 'length_mismatch' | 'malformed';
};
