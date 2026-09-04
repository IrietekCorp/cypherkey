import { describe, expect, test } from 'bun:test';
import {
  concatBytes,
  equalBytes,
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from './encoding';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('base64url', () => {
  test('round-trips every length from 0 to 70', () => {
    for (let n = 0; n <= 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(hex(fromBase64Url(toBase64Url(bytes)))).toBe(hex(bytes));
    }
  });

  test('matches the known vector', () => {
    expect(toBase64Url(Uint8Array.from([0x3e, 0x3f]))).toBe('Pj8');
    expect(hex(fromBase64Url('Pj8'))).toBe('3e3f');
  });

  test('uses the RFC 4648 §5 alphabet, so - and _ replace + and /', () => {
    // 0xfb 0xff encodes to "+/8" in standard base64.
    expect(toBase64Url(Uint8Array.from([0xfb, 0xff]))).toBe('-_8');
    expect(hex(fromBase64Url('-_8'))).toBe('fbff');
  });

  test('emits no padding', () => {
    for (let n = 0; n <= 8; n++) {
      expect(toBase64Url(new Uint8Array(n))).not.toContain('=');
    }
  });

  test('encodes and decodes the empty array', () => {
    expect(toBase64Url(new Uint8Array(0))).toBe('');
    expect(fromBase64Url('').length).toBe(0);
  });

  test('rejects standard-base64 characters and padding', () => {
    for (const bad of ['+/8', 'Pj8=', 'ab+c', 'ab/c', 'ab==']) {
      expect(() => fromBase64Url(bad)).toThrow(/base64url/);
    }
  });

  test('rejects whitespace anywhere', () => {
    for (const bad of [' Pj8', 'Pj8 ', 'Pj 8', 'Pj8\n', '\tPj8']) {
      expect(() => fromBase64Url(bad)).toThrow(/base64url/);
    }
  });

  test('rejects other non-alphabet characters and impossible lengths', () => {
    for (const bad of ['Pj8!', 'Pj8.', 'P', 'abcde']) {
      expect(() => fromBase64Url(bad)).toThrow(/base64url/);
    }
  });

  // A vault item ciphertext is far larger than a key; the encoder must not use
  // spread or apply, which blow the call stack on large inputs.
  test('handles a large buffer without overflowing the stack', () => {
    const big = Uint8Array.from({ length: 300_000 }, (_, i) => i & 0xff);
    expect(hex(fromBase64Url(toBase64Url(big)))).toBe(hex(big));
  });

  test('agrees with the platform base64 decoder', () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 11) & 0xff);
    const standard = Buffer.from(bytes).toString('base64');
    const ours = toBase64Url(bytes);
    expect(ours).toBe(standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  });
});

describe('utf8', () => {
  test('round-trips ASCII, accents, CJK and emoji', () => {
    for (const s of ['', 'hello', 'café', '密码', '🔑🎹', 'a\u0000b']) {
      expect(utf8Decode(utf8Encode(s))).toBe(s);
    }
  });

  test('encodes to the documented byte lengths', () => {
    expect(utf8Encode('a').length).toBe(1);
    expect(utf8Encode('é').length).toBe(2);
    expect(utf8Encode('密').length).toBe(3);
    expect(utf8Encode('🔑').length).toBe(4);
  });

  test('preserves an embedded NUL — Strict-mode KDF input depends on it (A-14.2)', () => {
    expect(hex(utf8Encode('a\u0000b'))).toBe('610062');
  });
});

describe('concatBytes', () => {
  test('joins in order', () => {
    expect(hex(concatBytes(Uint8Array.from([1, 2]), Uint8Array.from([3])))).toBe('010203');
  });

  test('handles no parts and empty parts', () => {
    expect(concatBytes().length).toBe(0);
    expect(hex(concatBytes(new Uint8Array(0), Uint8Array.from([9]), new Uint8Array(0)))).toBe('09');
  });

  test('does not alias its inputs', () => {
    const a = Uint8Array.from([1, 2]);
    const out = concatBytes(a);
    out[0] = 9;
    expect(a[0]).toBe(1);
  });
});

describe('equalBytes', () => {
  test('is true for identical contents in different arrays', () => {
    expect(equalBytes(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3]))).toBe(true);
  });

  test('is false on a length mismatch', () => {
    expect(equalBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 3]))).toBe(false);
    expect(equalBytes(new Uint8Array(0), Uint8Array.from([0]))).toBe(false);
  });

  test('is false for a difference at the first and at the last byte', () => {
    expect(equalBytes(Uint8Array.from([9, 2, 3]), Uint8Array.from([1, 2, 3]))).toBe(false);
    expect(equalBytes(Uint8Array.from([1, 2, 9]), Uint8Array.from([1, 2, 3]))).toBe(false);
  });

  test('is true for two empty arrays', () => {
    expect(equalBytes(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  // It must not short-circuit on the first differing byte.
  test('examines every byte regardless of where the difference is', () => {
    const a = new Uint8Array(1024).fill(7);
    const early = new Uint8Array(1024).fill(7);
    early[0] = 8;
    const late = new Uint8Array(1024).fill(7);
    late[1023] = 8;
    expect(equalBytes(a, early)).toBe(false);
    expect(equalBytes(a, late)).toBe(false);
  });
});
