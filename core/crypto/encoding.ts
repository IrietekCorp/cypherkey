import { equalBytes as nobleEqualBytes } from '@noble/curves/abstract/utils';

/** RFC 4648 §5 alphabet: base64 with `-` and `_` in place of `+` and `/`. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const LOOKUP = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encodes bytes as unpadded base64url. Written as an explicit loop rather than
 * `btoa(String.fromCharCode(...bytes))`, which overflows the call stack on inputs
 * the size of a vault item.
 */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      ALPHABET[(n >>> 18) & 63] +
      ALPHABET[(n >>> 12) & 63] +
      ALPHABET[(n >>> 6) & 63] +
      ALPHABET[n & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[(n >>> 18) & 63] + ALPHABET[(n >>> 12) & 63];
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[(n >>> 18) & 63] + ALPHABET[(n >>> 12) & 63] + ALPHABET[(n >>> 6) & 63];
  }
  return out;
}

/**
 * Decodes unpadded base64url. Throws on padding, on standard-base64 `+` and `/`,
 * on whitespace, and on any length that cannot come from an encode. The error
 * never quotes the input, which may be a wrapped key.
 */
export function fromBase64Url(s: string): Uint8Array {
  if (s.length % 4 === 1) {
    throw new Error('fromBase64Url: input is not valid unpadded base64url (impossible length)');
  }
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let written = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const value = code < 128 ? LOOKUP[code] : -1;
    if (value < 0) {
      throw new Error('fromBase64Url: input is not valid unpadded base64url');
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (buffer >>> bits) & 0xff;
    }
  }
  return out;
}

/** Encodes a string as UTF-8 bytes. Preserves embedded NUL, which A-14.2 relies on. */
export function utf8Encode(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Decodes UTF-8 bytes back to a string. */
export function utf8Decode(b: Uint8Array): string {
  return decoder.decode(b);
}

/** Concatenates byte arrays into a fresh buffer that aliases none of its inputs. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Constant-time byte comparison, for every secret comparison in `core/` (AGENTS §6).
 * Length is compared first and is not itself secret. Re-exported from `@noble/curves`,
 * not `@noble/hashes` — `equalBytes` does not exist in the latter.
 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return nobleEqualBytes(a, b);
}
