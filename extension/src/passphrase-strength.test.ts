import { describe, expect, test } from 'bun:test';
import {
  MIN_PASSPHRASE_LENGTH,
  MIN_ZXCVBN_SCORE,
  assessPassphrase,
  lengthProblems,
} from './passphrase-strength';

describe('lengthProblems', () => {
  test('an empty passphrase asks for one', () => {
    expect(lengthProblems('')).toEqual(['Enter a passphrase.']);
  });

  test('under the minimum says how short it is', () => {
    const problems = lengthProblems('short');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(String(MIN_PASSPHRASE_LENGTH));
    expect(problems[0]).toContain('has 5');
  });

  test('exactly the minimum is accepted', () => {
    expect(lengthProblems('a'.repeat(MIN_PASSPHRASE_LENGTH))).toEqual([]);
  });

  /** Length is counted in code points, so an emoji is one character, not two. */
  test('counts code points, not UTF-16 units', () => {
    const withAstral = `${'🔑'.repeat(MIN_PASSPHRASE_LENGTH)}`;
    expect(lengthProblems(withAstral)).toEqual([]);
    expect(lengthProblems('🔑'.repeat(MIN_PASSPHRASE_LENGTH - 1))).toHaveLength(1);
  });

  /** Callable on every keystroke: it must not need the lazy dictionary import. */
  test('is synchronous', () => {
    expect(Array.isArray(lengthProblems('anything'))).toBe(true);
  });
});

describe('assessPassphrase', () => {
  test('a strong passphrase is acceptable', async () => {
    const result = await assessPassphrase('correct horse battery staple');
    expect(result.acceptable).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(MIN_ZXCVBN_SCORE);
    expect(result.problems).toEqual([]);
  });

  test('a long but guessable passphrase is refused', async () => {
    // Long enough to pass the length rule, and still trivially guessable — which is
    // exactly why length alone is not the test.
    const result = await assessPassphrase('password123456');
    expect(result.acceptable).toBe(false);
    expect(result.problems.join(' ')).toContain('guessable');
  });

  test('a short but random passphrase is refused on length', async () => {
    const result = await assessPassphrase('xK9#pQ2');
    expect(result.acceptable).toBe(false);
    expect(result.problems.join(' ')).toContain(String(MIN_PASSPHRASE_LENGTH));
  });

  test('an empty passphrase scores zero and needs no dictionary', async () => {
    const result = await assessPassphrase('');
    expect(result.score).toBe(0);
    expect(result.acceptable).toBe(false);
  });

  test('carries a human label for each score', async () => {
    const weak = await assessPassphrase('password123456');
    const strong = await assessPassphrase('correct horse battery staple');
    expect(weak.label).not.toBe(strong.label);
    expect(strong.label.length).toBeGreaterThan(0);
  });

  test("passes through zxcvbn's own suggestions", async () => {
    const result = await assessPassphrase('password123456');
    expect(Array.isArray(result.suggestions)).toBe(true);
  });

  /**
   * The passphrase is scored in memory and must never appear in what comes back — a
   * strength meter that echoes the secret is a leak in every log and screenshot.
   */
  test('never echoes the passphrase in its output', async () => {
    const secret = 'correct horse battery staple';
    const result = await assessPassphrase(secret);
    const dumped = JSON.stringify(result);
    expect(dumped).not.toContain(secret);
    expect(dumped).not.toContain('correct horse');
  });
});
