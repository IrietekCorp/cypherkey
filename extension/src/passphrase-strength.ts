/**
 * Passphrase strength for onboarding (X-2).
 *
 * 12 characters and zxcvbn >= 3/4, ruled 2026-09-05 and recorded in docs/03 X-2. The
 * earlier B1 figures of 8 and 10 are superseded. The reasoning is asymmetric risk:
 * loosening this later is free, while tightening it later forces a re-key (A-16) on
 * every account below the new floor — so start strict.
 *
 * The passphrase is scored in memory and never stored, logged or sent. zxcvbn's
 * dictionaries are loaded lazily so they do not sit in the popup's initial chunk.
 */

/** docs/03 X-2, ruled 2026-09-05. The single place this number is written down. */
export const MIN_PASSPHRASE_LENGTH = 12;
/** zxcvbn's 0–4 scale; 3 is "safely unguessable without a targeted attack". */
export const MIN_ZXCVBN_SCORE = 3;

export type Strength = {
  score: 0 | 1 | 2 | 3 | 4;
  acceptable: boolean;
  /** Why it was refused. Empty when acceptable. */
  problems: string[];
  /** zxcvbn's own advice, passed through unchanged. */
  suggestions: string[];
  label: string;
};

const LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'] as const;

type Scorer = (input: string) => { score: number; feedback: { suggestions: string[] } };
let scorer: Scorer | null = null;

/**
 * Loads zxcvbn and its dictionaries once.
 *
 * Deliberately dynamic: `@zxcvbn-ts/language-common` is the bulk of the cost and is
 * only needed on the onboarding screen, so it must not be in the chunk that the unlock
 * screen pays for on every popup open.
 */
async function loadScorer(): Promise<Scorer> {
  if (scorer !== null) return scorer;
  const [{ ZxcvbnFactory }, common] = await Promise.all([
    import('@zxcvbn-ts/core'),
    import('@zxcvbn-ts/language-common'),
  ]);
  const zxcvbn = new ZxcvbnFactory({
    dictionary: common.dictionary,
    graphs: common.adjacencyGraphs,
  });
  scorer = (input: string) => zxcvbn.check(input);
  return scorer;
}

/** Warms the dictionaries while the user is still reading the screen. */
export async function warmStrength(): Promise<void> {
  await loadScorer();
}

/**
 * The rules that need no dictionary, so a caller can gate the button on every keystroke
 * without waiting for the lazy import.
 */
export function lengthProblems(resolved: string): string[] {
  const length = [...resolved].length;
  if (length === 0) return ['Enter a passphrase.'];
  if (length < MIN_PASSPHRASE_LENGTH) {
    return [`Use at least ${MIN_PASSPHRASE_LENGTH} characters — that one has ${length}.`];
  }
  return [];
}

export async function assessPassphrase(resolved: string): Promise<Strength> {
  const problems = lengthProblems(resolved);
  if (resolved.length === 0) {
    return { score: 0, acceptable: false, problems, suggestions: [], label: LABELS[0] };
  }

  const result = (await loadScorer())(resolved);
  const score = Math.min(4, Math.max(0, result.score)) as 0 | 1 | 2 | 3 | 4;
  if (score < MIN_ZXCVBN_SCORE) {
    problems.push('That passphrase is guessable. A few unrelated words work better.');
  }

  return {
    score,
    acceptable: problems.length === 0,
    problems,
    suggestions: result.feedback.suggestions,
    label: LABELS[score],
  };
}
