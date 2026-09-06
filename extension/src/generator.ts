/**
 * Password and passphrase generation.
 *
 * `crypto.getRandomValues` only — never `Math.random`, which is seeded from
 * predictable state and is not a security primitive in any engine.
 *
 * Sampling is rejection-based rather than `byte % alphabet.length`. The modulo shortcut
 * is only unbiased when the alphabet divides 256 evenly: with 62 symbols, bytes 0–247
 * map four times each and 248–255 map a fifth time to the first eight, so `a`–`h` come
 * up 25% more often than the rest. That is a real weakening of a generated password and
 * it is invisible in any output you would look at by eye.
 */

export type Randomness = (bytes: Uint8Array) => void;

const defaultRandom: Randomness = (bytes) => {
  crypto.getRandomValues(bytes);
};

export const ALPHABETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%^&*-_=+?',
} as const;

/**
 * Ambiguous characters are omitted from every class: no `l`, `I`, `O`, `0`, `1`.
 * A generated password gets read aloud, retyped from a screenshot, and copied off a
 * phone; `0` versus `O` costs more in support than the fraction of a bit it adds.
 */
export type CharacterOptions = {
  length: number;
  lower?: boolean;
  upper?: boolean;
  digits?: boolean;
  symbols?: boolean;
};

export type PassphraseOptions = {
  words: number;
  separator?: string;
};

/**
 * A word per ~8 bits. Short, common, unambiguous when spoken, and deliberately not a
 * dictionary of obscure words — a passphrase that cannot be repeated over the phone is
 * one people write down.
 *
 * Exactly 256 words, so each is exactly 8 bits and the entropy figure the UI shows is
 * a whole number rather than a rounded one. A test pins the count for that reason.
 *
 * The default word count is chosen to clear a real bar, not to look short: at 8 bits a
 * word, 10 words is 80 bits. A larger list (EFF's 7776 words, 12.9 bits each) would buy
 * shorter passphrases at the cost of roughly 100 KB in the popup — worth revisiting if
 * people find ten words tiresome.
 */
export const WORDS: readonly string[] = (
  'able acid aged also arch army atom aunt away axis baby back bald band bank barn ' +
  'base bath bead beam bean bear beat beef bell belt bend best bike bill bird bite ' +
  'blue boat bold bolt bone book boot born boss both bowl brew brick brief broom brush ' +
  'bulb bulk bump bunk bush busy cabin cable cake calm camp cane cape card care cart ' +
  'case cash cast cave cell chain chair chalk charm chase cheap chess chest chief chin ' +
  'chip city clay clean clear cliff climb clock cloth cloud coal coast coat code coin ' +
  'cold cook cool copy cord cork corn cost couch count court cover crab craft crane ' +
  'crash cream crew crisp crop cross crowd crown cube cup curl curve cycle dairy dance ' +
  'dark dawn deal debt deck deep deer dense desk dial diet dish dive dock dodge dog ' +
  'doll dome door dose dove down draft drain drama draw dream dress drift drill drink ' +
  'drive drop drum dry duck dust duty eager eagle early earth ease east easy edge eight ' +
  'elbow elder elm empty end enemy energy enjoy enter equal error event exact exit face ' +
  'fact fade fair fall false fancy far farm fast fear feast fence fern few field fifth ' +
  'fig file fill film find fine fire firm fish fist five flag flame flash flat fleet ' +
  'flesh float flock floor flour flow fluid flute foam focus fog fold folk food fool ' +
  'forest fork form fort found four frame free fresh frog front frost fruit fuel full ' +
  'fund fur gain game gap garden gate gear'
)
  .split(' ')
  .filter((w) => w.length > 0);

/**
 * One value in `[0, max)`, uniformly.
 *
 * Bytes at or above the largest multiple of `max` are discarded rather than folded in.
 * Discarding is what makes it uniform; folding is the bias described above.
 */
function uniform(max: number, random: Randomness): number {
  if (max <= 0) throw new Error('uniform: max must be positive');
  const limit = Math.floor(256 / max) * max;
  const byte = new Uint8Array(1);
  for (;;) {
    random(byte);
    const value = byte[0] as number;
    if (value < limit) return value % max;
  }
}

/** The alphabet the given options select. */
export function alphabetFor(options: CharacterOptions): string {
  const parts = [
    options.lower === false ? '' : ALPHABETS.lower,
    options.upper === false ? '' : ALPHABETS.upper,
    options.digits === false ? '' : ALPHABETS.digits,
    options.symbols === true ? ALPHABETS.symbols : '',
  ];
  const alphabet = parts.join('');
  if (alphabet.length === 0) throw new Error('generatePassword: no character classes selected');
  return alphabet;
}

export function generatePassword(
  options: CharacterOptions,
  random: Randomness = defaultRandom,
): string {
  if (options.length <= 0) throw new Error('generatePassword: length must be positive');
  const alphabet = alphabetFor(options);
  let out = '';
  for (let i = 0; i < options.length; i++) {
    out += alphabet[uniform(alphabet.length, random)];
  }
  return out;
}

export function generatePassphrase(
  options: PassphraseOptions,
  random: Randomness = defaultRandom,
  words: readonly string[] = WORDS,
): string {
  if (options.words <= 0) throw new Error('generatePassphrase: words must be positive');
  const chosen: string[] = [];
  for (let i = 0; i < options.words; i++) {
    chosen.push(words[uniform(words.length, random)] as string);
  }
  return chosen.join(options.separator ?? '-');
}

/**
 * Bits of entropy, so the UI can state it rather than imply strength with a colour.
 *
 * This is the *generator's* entropy — what an attacker faces who knows exactly how the
 * value was made and has to search the space. It is not zxcvbn's score, which estimates
 * how guessable a human-chosen string is; the two answer different questions and a
 * generated value should be judged by this one.
 */
export function entropyBits(kind: 'password', options: CharacterOptions): number;
export function entropyBits(
  kind: 'passphrase',
  options: PassphraseOptions,
  listSize?: number,
): number;
export function entropyBits(
  kind: 'password' | 'passphrase',
  options: CharacterOptions | PassphraseOptions,
  listSize = WORDS.length,
): number {
  if (kind === 'password') {
    const opts = options as CharacterOptions;
    return Math.floor(opts.length * Math.log2(alphabetFor(opts).length));
  }
  return Math.floor((options as PassphraseOptions).words * Math.log2(listSize));
}

/** The fewest words that clear a given strength with the list in hand. */
export function wordsForBits(bits: number, listSize = WORDS.length): number {
  return Math.ceil(bits / Math.log2(listSize));
}
