import { describe, expect, spyOn, test } from 'bun:test';
import {
  RECOVERY_SECRET_BYTES,
  formatRecoveryCode,
  generateRecoveryCode,
  parseRecoveryCode,
  recoveryAuthHashFromKey,
  recoveryKeyFromCode,
} from './recovery';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const SECRET = Uint8Array.from({ length: 20 }, (_, i) => i * 11);
const CODE = formatRecoveryCode(SECRET);

describe('shape of the code', () => {
  test('carries 160 bits in 32 data symbols plus one check symbol', () => {
    expect(RECOVERY_SECRET_BYTES).toBe(20);
    expect(CODE.replace(/-/g, '').length).toBe(33);
  });

  test('is grouped for transcription and uses only the Crockford alphabet', () => {
    expect(CODE).toMatch(/^[0-9A-TV-Z*~$=]{4}(-[0-9A-TV-Z*~$=]{4}){6}-[0-9A-TV-Z*~$=]{5}$/);
  });

  test('omits I, L, O and U from the data symbols, which are the confusable ones', () => {
    for (let i = 0; i < 200; i++) {
      const data = generateRecoveryCode().replace(/-/g, '').slice(0, 32);
      expect(data).not.toMatch(/[ILOU]/);
    }
  });
});

describe('generateRecoveryCode', () => {
  test('round-trips through parse', () => {
    const code = generateRecoveryCode();
    expect(formatRecoveryCode(parseRecoveryCode(code))).toBe(code);
  });

  test('does not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateRecoveryCode());
    expect(seen.size).toBe(500);
  });

  test('is not biased toward any symbol position', () => {
    // A packing bug would pin the first or last symbol to a constant.
    const first = new Set<string>();
    const last = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const data = generateRecoveryCode().replace(/-/g, '');
      first.add(data[0] as string);
      last.add(data[31] as string);
    }
    expect(first.size).toBeGreaterThan(8);
    expect(last.size).toBeGreaterThan(8);
  });
});

describe('parseRecoveryCode', () => {
  test('recovers the exact secret', () => {
    expect(hex(parseRecoveryCode(CODE))).toBe(hex(SECRET));
  });

  test('is case-insensitive', () => {
    expect(hex(parseRecoveryCode(CODE.toLowerCase()))).toBe(hex(SECRET));
    expect(hex(parseRecoveryCode(CODE.toUpperCase()))).toBe(hex(SECRET));
  });

  test('ignores hyphens and surrounding whitespace however the user types them', () => {
    const raw = CODE.replace(/-/g, '');
    expect(hex(parseRecoveryCode(raw))).toBe(hex(SECRET));
    expect(hex(parseRecoveryCode(`  ${CODE}  `))).toBe(hex(SECRET));
    expect(hex(parseRecoveryCode(raw.replace(/(.{8})/g, '$1 ').trim()))).toBe(hex(SECRET));
  });

  test('accepts the Crockford aliases O→0 and I/L→1', () => {
    const secret = new Uint8Array(20);
    const code = formatRecoveryCode(secret).replace(/-/g, '');
    expect(code.slice(0, 32)).toBe('0'.repeat(32));
    expect(hex(parseRecoveryCode(`${'O'.repeat(32)}${code[32]}`))).toBe(hex(secret));

    const ones = parseRecoveryCode(CODE);
    const withAliases = CODE.replace(/1/g, 'I');
    expect(hex(parseRecoveryCode(withAliases))).toBe(hex(ones));
    expect(hex(parseRecoveryCode(CODE.replace(/1/g, 'L')))).toBe(hex(ones));
  });

  test('rejects a wrong length', () => {
    const raw = CODE.replace(/-/g, '');
    expect(() => parseRecoveryCode(raw.slice(0, 32))).toThrow(/recovery code/i);
    expect(() => parseRecoveryCode(`${raw}A`)).toThrow(/recovery code/i);
    expect(() => parseRecoveryCode('')).toThrow(/recovery code/i);
  });

  test('rejects characters outside the alphabet', () => {
    const raw = CODE.replace(/-/g, '');
    expect(() => parseRecoveryCode(`#${raw.slice(1)}`)).toThrow(/recovery code/i);
  });

  test('the error never quotes the code the user typed', () => {
    const raw = CODE.replace(/-/g, '');
    let message = '';
    try {
      parseRecoveryCode(`${raw.slice(0, 31)}#${raw[32]}`);
    } catch (e) {
      message = `${String(e)} ${(e as Error).stack ?? ''}`;
    }
    expect(message).toMatch(/recovery code/i);
    expect(message).not.toContain(raw.slice(0, 10));
  });
});

describe('the check symbol', () => {
  const DATA_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  test('catches every single-character substitution at every position', () => {
    const raw = CODE.replace(/-/g, '');
    let checked = 0;
    for (let i = 0; i < 32; i++) {
      for (const symbol of DATA_ALPHABET) {
        if (symbol === raw[i]) continue;
        const typo = raw.slice(0, i) + symbol + raw.slice(i + 1);
        expect(() => parseRecoveryCode(typo)).toThrow(/check/i);
        checked++;
      }
    }
    expect(checked).toBe(32 * 31);
  });

  test('catches a transposition of two adjacent differing symbols', () => {
    const raw = CODE.replace(/-/g, '');
    let found = 0;
    for (let i = 0; i < 31; i++) {
      if (raw[i] === raw[i + 1]) continue;
      const swapped = raw.slice(0, i) + raw[i + 1] + raw[i] + raw.slice(i + 2);
      expect(() => parseRecoveryCode(swapped)).toThrow(/check/i);
      found++;
    }
    expect(found).toBeGreaterThan(20);
  });

  test('catches a mistyped check symbol itself', () => {
    const raw = CODE.replace(/-/g, '');
    const wrong = raw[32] === '0' ? '1' : '0';
    expect(() => parseRecoveryCode(raw.slice(0, 32) + wrong)).toThrow(/check/i);
  });
});

describe('recoveryKeyFromCode', () => {
  test('returns a 32-byte key', async () => {
    expect((await recoveryKeyFromCode(CODE)).length).toBe(32);
  });

  test('is deterministic and independent of formatting or case', async () => {
    const a = await recoveryKeyFromCode(CODE);
    const b = await recoveryKeyFromCode(CODE.replace(/-/g, '').toLowerCase());
    expect(hex(a)).toBe(hex(b));
  });

  test('different codes give different keys', async () => {
    const a = await recoveryKeyFromCode(generateRecoveryCode());
    const b = await recoveryKeyFromCode(generateRecoveryCode());
    expect(hex(a)).not.toBe(hex(b));
  });

  test('the key is not the secret — it is stretched through HKDF', async () => {
    const key = await recoveryKeyFromCode(CODE);
    expect(hex(key)).not.toContain(hex(SECRET));
  });

  test('rejects a code that fails its checksum', async () => {
    const raw = CODE.replace(/-/g, '');
    const wrong = raw[0] === '0' ? '1' : '0';
    await expect(recoveryKeyFromCode(wrong + raw.slice(1))).rejects.toThrow(/check/i);
  });
});

describe('key material never reaches a log', () => {
  test('no operation writes to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const code = generateRecoveryCode();
      parseRecoveryCode(code);
      await recoveryKeyFromCode(code);
      try {
        parseRecoveryCode('nonsense');
      } catch {
        /* expected */
      }
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

/**
 * M2-00f. Recovery must be server-authenticated, which needs a verifier the server can
 * check without ever being able to unwrap the vault itself.
 */
describe('recoveryAuthHashFromKey', () => {
  test('is deterministic for a given Kit', async () => {
    const code = generateRecoveryCode();
    const key = await recoveryKeyFromCode(code);
    expect(await recoveryAuthHashFromKey(key)).toEqual(await recoveryAuthHashFromKey(key));
  });

  test('is 32 bytes', async () => {
    const key = await recoveryKeyFromCode(generateRecoveryCode());
    expect((await recoveryAuthHashFromKey(key)).length).toBe(32);
  });

  test('differs from the key that unwraps the vault', async () => {
    const key = await recoveryKeyFromCode(generateRecoveryCode());
    const auth = await recoveryAuthHashFromKey(key);
    // If these were equal, storing the verifier would hand the server the wrap key.
    expect(auth).not.toEqual(key);
  });

  test('a different Kit yields a different verifier', async () => {
    const a = await recoveryAuthHashFromKey(await recoveryKeyFromCode(generateRecoveryCode()));
    const b = await recoveryAuthHashFromKey(await recoveryKeyFromCode(generateRecoveryCode()));
    expect(a).not.toEqual(b);
  });

  test('the same Kit re-entered with different formatting verifies the same', async () => {
    const code = generateRecoveryCode();
    const spaced = code.toLowerCase().replace(/-/g, ' ');
    const fromCanonical = await recoveryAuthHashFromKey(await recoveryKeyFromCode(code));
    const fromSpaced = await recoveryAuthHashFromKey(await recoveryKeyFromCode(spaced));
    expect(fromSpaced).toEqual(fromCanonical);
  });
});
