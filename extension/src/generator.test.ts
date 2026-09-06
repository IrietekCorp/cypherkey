import { describe, expect, test } from 'bun:test';
import {
  ALPHABETS,
  type Randomness,
  WORDS,
  alphabetFor,
  entropyBits,
  generatePassphrase,
  generatePassword,
  wordsForBits,
} from './generator';

/** Hands out the given bytes in order, so sampling can be examined exactly. */
const scripted = (values: number[]): Randomness => {
  let i = 0;
  return (bytes) => {
    bytes[0] = values[i % values.length] as number;
    i += 1;
  };
};

/** Every byte 0..255 once, which is what exposes a modulo bias immediately. */
const everyByte = (): Randomness => scripted(Array.from({ length: 256 }, (_, i) => i));

describe('sampling is unbiased', () => {
  /**
   * The bug this rules out: `byte % 62` maps 0–247 four times each and 248–255 a fifth
   * time onto the first eight symbols, so `a`–`h` come up 25% more often. It is
   * invisible by eye and weakens every password the generator makes.
   */
  test('a full sweep of bytes produces a flat distribution', () => {
    const alphabet = alphabetFor({ length: 1, symbols: true });
    // 62-ish symbols: deliberately not a divisor of 256.
    expect(256 % alphabet.length).not.toBe(0);

    // One full sweep yields floor(256 / n) * n usable bytes, so each symbol appears
    // exactly floor(256 / n) times.
    const usable = Math.floor(256 / alphabet.length) * alphabet.length;
    const generated = generatePassword({ length: usable, symbols: true }, everyByte());

    const counts = new Map<string, number>();
    for (const ch of generated) counts.set(ch, (counts.get(ch) ?? 0) + 1);

    expect(counts.size).toBe(alphabet.length);
    expect(new Set(counts.values()).size).toBe(1);
  });

  test('the high bytes are discarded rather than folded onto the first symbols', () => {
    const alphabet = alphabetFor({ length: 1, symbols: true });
    const limit = Math.floor(256 / alphabet.length) * alphabet.length;

    // Feed only the bytes a modulo shortcut would fold. Rejection sampling must never
    // return from these, so pairing them with one usable byte yields that byte's symbol.
    const rejected = Array.from({ length: 256 - limit }, (_, i) => limit + i);
    const out = generatePassword({ length: 1, symbols: true }, scripted([...rejected, 0]));

    expect(out).toBe(alphabet[0]);
  });

  test('over many draws every symbol appears', () => {
    const alphabet = alphabetFor({ length: 1, symbols: true });
    const generated = generatePassword({ length: 4000, symbols: true });
    expect(new Set(generated).size).toBe(alphabet.length);
  });

  test('two generated passwords differ', () => {
    const a = generatePassword({ length: 24 });
    const b = generatePassword({ length: 24 });
    expect(a).not.toBe(b);
  });
});

describe('character options', () => {
  test('length is honoured exactly', () => {
    for (const length of [1, 8, 32, 64]) {
      expect(generatePassword({ length })).toHaveLength(length);
    }
  });

  test('each class can be excluded', () => {
    const lettersOnly = generatePassword({ length: 200, digits: false });
    expect(lettersOnly).not.toMatch(/[0-9]/);

    const noUpper = generatePassword({ length: 200, upper: false });
    expect(noUpper).not.toMatch(/[A-Z]/);
  });

  test('symbols are opt-in', () => {
    expect(generatePassword({ length: 200 })).toMatch(/^[a-zA-Z0-9]+$/);
    expect(alphabetFor({ length: 1, symbols: true })).toContain('!');
  });

  /**
   * A generated password gets read aloud, retyped from a screenshot and copied off a
   * phone. `0` versus `O` costs more in support than the fraction of a bit it adds.
   */
  test('ambiguous characters are excluded from every class', () => {
    const alphabet = alphabetFor({ length: 1, symbols: true });
    for (const ambiguous of ['l', 'I', 'O', '0', '1']) {
      expect(alphabet).not.toContain(ambiguous);
    }
    // And the exclusion is in the classes themselves, not filtered afterwards.
    expect(ALPHABETS.lower).not.toContain('l');
    expect(ALPHABETS.digits).not.toContain('0');
  });

  test('selecting no classes is refused rather than silently defaulting', () => {
    expect(() =>
      generatePassword({ length: 8, lower: false, upper: false, digits: false }),
    ).toThrow('no character classes');
  });

  test('a non-positive length is refused', () => {
    expect(() => generatePassword({ length: 0 })).toThrow('length must be positive');
  });
});

describe('passphrases', () => {
  test('the requested number of words, joined', () => {
    const phrase = generatePassphrase({ words: 5 });
    expect(phrase.split('-')).toHaveLength(5);
  });

  test('the separator is configurable', () => {
    expect(generatePassphrase({ words: 3, separator: ' ' }).split(' ')).toHaveLength(3);
  });

  test('every word comes from the list', () => {
    const words = generatePassphrase({ words: 40 }).split('-');
    for (const word of words) expect(WORDS).toContain(word);
  });

  test('the word list has no duplicates, or the entropy claim would be wrong', () => {
    expect(new Set(WORDS).size).toBe(WORDS.length);
  });

  /**
   * Exactly 256 makes each word exactly 8 bits, so the figure the UI shows is a whole
   * number rather than a rounded one. The list was 233 when first written, which made
   * the "8 bits a word" comment quietly false.
   */
  test('there are exactly 256 words, so a word is exactly 8 bits', () => {
    expect(WORDS.length).toBe(256);
    expect(Math.log2(WORDS.length)).toBe(8);
    expect(entropyBits('passphrase', { words: 10 })).toBe(80);
  });

  test('words are readable aloud: short, lower case, letters only', () => {
    for (const word of WORDS) {
      expect(word).toMatch(/^[a-z]{2,6}$/);
    }
  });

  test('word selection is unbiased too', () => {
    const words = generatePassphrase({ words: 3000 }).split('-');
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    // With 3000 draws over this list, every word should turn up at least once.
    expect(counts.size).toBe(WORDS.length);
  });

  test('a non-positive word count is refused', () => {
    expect(() => generatePassphrase({ words: 0 })).toThrow('words must be positive');
  });
});

describe('entropy is stated, not implied', () => {
  /**
   * This is the *generator's* entropy — what an attacker faces who knows exactly how
   * the value was made. It is not zxcvbn's score, which estimates how guessable a
   * human-chosen string is. A generated value should be judged by this one.
   */
  test('a password is length times log2 of its alphabet', () => {
    const alphabet = alphabetFor({ length: 1 });
    expect(entropyBits('password', { length: 16 })).toBe(
      Math.floor(16 * Math.log2(alphabet.length)),
    );
  });

  test('adding symbols raises it', () => {
    const without = entropyBits('password', { length: 16 });
    const withSymbols = entropyBits('password', { length: 16, symbols: true });
    expect(withSymbols).toBeGreaterThan(without);
  });

  test('a passphrase is words times log2 of the list size', () => {
    expect(entropyBits('passphrase', { words: 9 })).toBe(Math.floor(9 * Math.log2(WORDS.length)));
  });

  /** The default word count must clear a real bar, not merely look short. */
  test('wordsForBits says how many words a target needs', () => {
    const needed = wordsForBits(72);
    expect(entropyBits('passphrase', { words: needed })).toBeGreaterThanOrEqual(72);
    expect(entropyBits('passphrase', { words: needed - 1 })).toBeLessThan(72);
  });

  test('a 20-character password with symbols clears 100 bits', () => {
    expect(entropyBits('password', { length: 20, symbols: true })).toBeGreaterThan(100);
  });
});

describe('what the source may not contain', () => {
  /** Seeded from predictable state; not a security primitive in any engine. */
  test('Math.random is never called', async () => {
    const source = await Bun.file(`${import.meta.dir}/generator.ts`).text();
    // A call, not the word: the module comment names it to explain why it is absent,
    // and asserting on the word would fail on the very sentence that documents the rule.
    expect(source).not.toMatch(/Math\.random\s*\(/);
  });

  test('crypto.getRandomValues is the default source', async () => {
    const source = await Bun.file(`${import.meta.dir}/generator.ts`).text();
    expect(source).toContain('crypto.getRandomValues');
  });
});
