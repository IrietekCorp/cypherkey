import { describe, expect, spyOn, test } from 'bun:test';
import { BACKSPACE, ESCAPE, MODIFIER_TOKENS } from '../biometrics/script';
import { toBase64Url, utf8Encode } from './encoding';
import { deriveMasterKey, deriveSubkey, randomBytes } from './kdf';
import {
  COMMITMENT_BYTES,
  type Strictness,
  budget,
  kdfInput,
  rhythmBands,
  scriptCommitments,
} from './phantom';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(8);

/** "passss⌫⌫w0rd" — the A-14 worked example: 12 tokens resolving to 8 characters. */
const SCRIPT = `passss${BACKSPACE}${BACKSPACE}w0rd`;
const RESOLVED = 'passw0rd';

describe('kdfInput (A-14.2)', () => {
  test('Medium and Relaxed feed the resolved passphrase alone', () => {
    expect(hex(kdfInput(RESOLVED, SCRIPT, 'medium'))).toBe(hex(utf8Encode(RESOLVED)));
    expect(hex(kdfInput(RESOLVED, SCRIPT, 'relaxed'))).toBe(hex(utf8Encode(RESOLVED)));
  });

  test('so changing the phantoms does not change the master key outside Strict', () => {
    const a = kdfInput(RESOLVED, SCRIPT, 'medium');
    const b = kdfInput(RESOLVED, `${RESOLVED}${ESCAPE}`, 'medium');
    expect(hex(a)).toBe(hex(b));
  });

  test('Strict folds the script in, separated by a NUL', () => {
    const strict = kdfInput(RESOLVED, SCRIPT, 'strict');
    expect(hex(strict)).toBe(`${hex(utf8Encode(RESOLVED))}00${hex(utf8Encode(SCRIPT))}`);
  });

  test('Strict and Medium differ for the same inputs', () => {
    expect(hex(kdfInput(RESOLVED, SCRIPT, 'strict'))).not.toBe(
      hex(kdfInput(RESOLVED, SCRIPT, 'medium')),
    );
  });

  test('under Strict, two scripts with the same resolved text give different input', () => {
    const a = kdfInput(RESOLVED, SCRIPT, 'strict');
    const b = kdfInput(RESOLVED, `${RESOLVED}${ESCAPE}`, 'strict');
    expect(hex(a)).not.toBe(hex(b));
  });

  // The separator is what stops "ab" + "c" colliding with "a" + "bc".
  test('the NUL separator makes the boundary unambiguous', () => {
    expect(hex(kdfInput('ab', 'c', 'strict'))).not.toBe(hex(kdfInput('a', 'bc', 'strict')));
  });

  test('a wrong resolved passphrase changes the input in every mode', () => {
    for (const level of ['strict', 'medium', 'relaxed'] as Strictness[]) {
      expect(hex(kdfInput(RESOLVED, SCRIPT, level))).not.toBe(
        hex(kdfInput('passw0rD', SCRIPT, level)),
      );
    }
  });
});

describe('scriptCommitments (A-14.2)', () => {
  test('one 16-byte commitment per token, in order', async () => {
    const commitments = await scriptCommitments(KEY, SCRIPT);
    expect(commitments).toHaveLength(12);
    for (const c of commitments) expect(c.length).toBe(COMMITMENT_BYTES);
  });

  test('different tokens commit differently', async () => {
    const c = await scriptCommitments(KEY, 'abc');
    expect(new Set(c.map(hex)).size).toBe(3);
  });

  test('repeated tokens commit identically — the disclosed equality leak', async () => {
    const c = await scriptCommitments(KEY, 'aba');
    expect(hex(c[0] as Uint8Array)).toBe(hex(c[2] as Uint8Array));
    expect(hex(c[0] as Uint8Array)).not.toBe(hex(c[1] as Uint8Array));
  });

  test('a different key gives entirely different commitments for the same script', async () => {
    const a = await scriptCommitments(KEY, SCRIPT);
    const b = await scriptCommitments(OTHER_KEY, SCRIPT);
    for (let i = 0; i < a.length; i++) {
      expect(hex(a[i] as Uint8Array)).not.toBe(hex(b[i] as Uint8Array));
    }
  });

  test('is deterministic, or a login could never match an enrollment', async () => {
    expect((await scriptCommitments(KEY, SCRIPT)).map(hex)).toEqual(
      (await scriptCommitments(KEY, SCRIPT)).map(hex),
    );
  });

  test('commits phantoms exactly like printable tokens', async () => {
    const c = await scriptCommitments(KEY, `a${BACKSPACE}${ESCAPE}${MODIFIER_TOKENS.Control}`);
    expect(c).toHaveLength(4);
    expect(new Set(c.map(hex)).size).toBe(4);
  });

  test('order is preserved, so a reordered script commits differently', async () => {
    const a = (await scriptCommitments(KEY, 'ab')).map(hex);
    const b = (await scriptCommitments(KEY, 'ba')).map(hex);
    expect(a).toEqual([b[1], b[0]]);
    expect(a).not.toEqual(b);
  });

  test('an empty script commits to nothing', async () => {
    expect(await scriptCommitments(KEY, '')).toHaveLength(0);
  });

  test('the commitment does not contain the token it commits to', async () => {
    const [commitment] = await scriptCommitments(KEY, 'Z');
    expect(Buffer.from(commitment as Uint8Array).toString('utf8')).not.toContain('Z');
  });

  test('works with a real phantomKey from the A-2 hierarchy', async () => {
    const phantomKey = await deriveSubkey(randomBytes(32), 'cypherkey/phantom/v1');
    expect(await scriptCommitments(phantomKey, SCRIPT)).toHaveLength(12);
  });
});

describe('kdfInput feeds Argon2id, which is why Strictness is a re-key', () => {
  const FAST = { m: 256, t: 1, p: 1 } as const;
  const SALT = new Uint8Array(16).fill(3);

  test('Strict and Medium produce different master keys from the same passphrase', async () => {
    const strict = await deriveMasterKey(kdfInput(RESOLVED, SCRIPT, 'strict'), SALT, FAST);
    const medium = await deriveMasterKey(kdfInput(RESOLVED, SCRIPT, 'medium'), SALT, FAST);
    expect(hex(strict)).not.toBe(hex(medium));
  });

  test('Medium and Relaxed produce the same master key, so switching between them is free', async () => {
    const medium = await deriveMasterKey(kdfInput(RESOLVED, SCRIPT, 'medium'), SALT, FAST);
    const relaxed = await deriveMasterKey(kdfInput(RESOLVED, SCRIPT, 'relaxed'), SALT, FAST);
    expect(hex(medium)).toBe(hex(relaxed));
  });

  test('under Strict, a different script is a different master key', async () => {
    const a = await deriveMasterKey(kdfInput(RESOLVED, SCRIPT, 'strict'), SALT, FAST);
    const b = await deriveMasterKey(kdfInput(RESOLVED, `${SCRIPT}${ESCAPE}`, 'strict'), SALT, FAST);
    expect(hex(a)).not.toBe(hex(b));
  });

  test('the embedded NUL survives into the KDF rather than truncating the input', async () => {
    const withScript = await deriveMasterKey(kdfInput('ab', 'cd', 'strict'), SALT, FAST);
    const resolvedOnly = await deriveMasterKey(kdfInput('ab', '', 'medium'), SALT, FAST);
    expect(hex(withScript)).not.toBe(hex(resolvedOnly));
  });
});

describe('budget (A-16)', () => {
  test('the documented table', () => {
    expect(budget('medium', 10)).toEqual({ maxInsertions: 2, maxMissing: 0 });
    expect(budget('medium', 25)).toEqual({ maxInsertions: 4, maxMissing: 0 });
    expect(budget('relaxed', 10)).toEqual({ maxInsertions: 4, maxMissing: 1 });
    expect(budget('relaxed', 25)).toEqual({ maxInsertions: 8, maxMissing: 1 });
    expect(budget('strict', 10)).toEqual({ maxInsertions: 0, maxMissing: 0 });
    expect(budget('strict', 25)).toEqual({ maxInsertions: 0, maxMissing: 0 });
  });

  test('Strict forgives nothing at any length', () => {
    for (const n of [1, 12, 100, 1000]) {
      expect(budget('strict', n)).toEqual({ maxInsertions: 0, maxMissing: 0 });
    }
  });

  test('Medium never forgives a missing token, at any length', () => {
    for (const n of [12, 25, 60, 600]) {
      expect(budget('medium', n).maxMissing).toBe(0);
    }
  });

  // Two insertions is one typo-and-correct; that is the slip the floor exists for.
  test('Medium always allows at least a typo and its correction', () => {
    for (const n of [1, 6, 12, 19]) {
      expect(budget('medium', n).maxInsertions).toBeGreaterThanOrEqual(2);
    }
  });

  test('the allowance grows with script length but never shrinks', () => {
    for (const level of ['medium', 'relaxed'] as Strictness[]) {
      let previous = -1;
      for (let n = 1; n <= 200; n++) {
        const current = budget(level, n).maxInsertions;
        expect(current).toBeGreaterThanOrEqual(previous);
        previous = current;
      }
    }
  });

  test('Relaxed is never stricter than Medium', () => {
    for (let n = 1; n <= 200; n++) {
      expect(budget('relaxed', n).maxInsertions).toBeGreaterThanOrEqual(
        budget('medium', n).maxInsertions,
      );
      expect(budget('relaxed', n).maxMissing).toBeGreaterThanOrEqual(
        budget('medium', n).maxMissing,
      );
    }
  });

  /**
   * The property the asymmetry exists for: someone who knows only the resolved
   * passphrase types it, which reads as one deletion per phantom. With two phantoms
   * that is two deletions, and no level forgives two.
   */
  test('typing only the resolved passphrase is never within budget with two phantoms', () => {
    for (const level of ['strict', 'medium', 'relaxed'] as Strictness[]) {
      expect(budget(level, 12).maxMissing).toBeLessThan(2);
    }
  });
});

describe('rhythmBands (A-16)', () => {
  test('the documented thresholds', () => {
    expect(rhythmBands('strict')).toEqual({ pass: 0.7, grey: 0.55 });
    expect(rhythmBands('medium')).toEqual({ pass: 0.62, grey: 0.45 });
    expect(rhythmBands('relaxed')).toEqual({ pass: 0.55, grey: 0.4 });
  });

  test('pass is always above grey, and stricter levels are always higher', () => {
    for (const level of ['strict', 'medium', 'relaxed'] as Strictness[]) {
      const b = rhythmBands(level);
      expect(b.pass).toBeGreaterThan(b.grey);
    }
    expect(rhythmBands('strict').pass).toBeGreaterThan(rhythmBands('medium').pass);
    expect(rhythmBands('medium').pass).toBeGreaterThan(rhythmBands('relaxed').pass);
  });
});

describe('nothing here reaches a log', () => {
  test('no operation writes to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      kdfInput(RESOLVED, SCRIPT, 'strict');
      await scriptCommitments(KEY, SCRIPT);
      budget('medium', 12);
      rhythmBands('medium');
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  test('a commitment sequence carries neither the script nor the key', async () => {
    const commitments = await scriptCommitments(KEY, SCRIPT);
    const wire = commitments.map(toBase64Url).join('');
    expect(wire).not.toContain(toBase64Url(utf8Encode(SCRIPT)));
    expect(wire).not.toContain(toBase64Url(KEY));
  });
});
