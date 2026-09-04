/**
 * One raw event captured during passphrase entry. Timestamps are high-resolution
 * (`performance.now()`). A `blur` carries no key: losing focus voids the sample,
 * which is how A-14.1 enforces "the key did not move focus" without a per-OS list.
 */
export type KeyEvent =
  | { type: 'down' | 'up'; key: string; t: number }
  | { type: 'blur'; t: number };

/** Why a sample could not be turned into a script (A-14.1). */
export type ScriptError = 'unsupported_key' | 'unsupported_combo' | 'focus_lost' | 'malformed';

/**
 * Fixed-order biometric feature vector for a script of `len` tokens.
 * Total length is `3*len + 5` per A-4.2 — n dwell, n−1 flight, n−1 digraph
 * (that is `3n − 2`), plus 7 globals:
 * [totalTime, meanDwell, stdDwell, meanFlight, stdFlight, meanDigraph, stdDigraph].
 */
export type FeatureVector = {
  version: 1;
  len: number;
  values: number[];
};

export type FeatureExtractionError = {
  error: ScriptError | 'length_mismatch';
};
