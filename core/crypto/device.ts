import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { randomBytes } from './kdf';

/** An Ed25519 device identity: a 32-byte private seed and its 32-byte public key. */
export type DeviceKeyPair = { pub: Uint8Array; priv: Uint8Array };

/** Everything the A-3 signing string covers. `path` includes the query, never a host. */
export type RequestToSign = {
  nonce: Uint8Array;
  ts: number;
  method: string;
  path: string;
  body: Uint8Array;
};

/** Version prefix, so a future signing format can never be confused with this one. */
const SIG_VERSION = 'cypherkey-sig-v1';

const SEED_BYTES = 32;
const PUBLIC_BYTES = 32;
const SIGNATURE_BYTES = 64;

const utf8 = new TextEncoder();

function toHex(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += byte.toString(16).padStart(2, '0');
  return s;
}

/** Base64url, unpadded — the transport encoding for every binary value on the wire. */
function toBase64Url(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Reverses `toBase64Url`. Returns undefined for anything that is not valid base64url. */
function fromBase64Url(s: string): Uint8Array | undefined {
  if (s.length === 0 || !/^[A-Za-z0-9_-]+$/.test(s)) return undefined;
  try {
    const binary = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/**
 * Builds the exact bytes A-3 signs. Fields are newline-delimited and version-prefixed
 * so that content cannot be shifted across a boundary to forge a different request.
 * The body appears only as a SHA-256 hash — never in the string itself.
 */
export function signingString(req: RequestToSign): string {
  if (!Number.isInteger(req.ts)) {
    throw new Error('signingString: ts must be an integer (milliseconds since epoch)');
  }
  if (!req.path.startsWith('/') || req.path.includes('://')) {
    throw new Error('signingString: path must start with "/" and carry no scheme or host');
  }
  return [
    SIG_VERSION,
    toHex(req.nonce),
    String(req.ts),
    req.method.toUpperCase(),
    req.path,
    toHex(sha256(req.body)),
  ].join('\n');
}

/** Generates a device identity. The private seed never leaves the client unwrapped (A-3). */
export async function generateDeviceKey(): Promise<DeviceKeyPair> {
  const priv = randomBytes(SEED_BYTES);
  return { pub: ed25519.getPublicKey(priv), priv };
}

/** Signs a request per A-3. Returns the signature base64url-encoded. */
export async function signRequest(priv: Uint8Array, req: RequestToSign): Promise<string> {
  if (priv.length !== SEED_BYTES) {
    throw new Error(`signRequest: priv must be ${SEED_BYTES} bytes, got ${priv.length}`);
  }
  return toBase64Url(ed25519.sign(utf8.encode(signingString(req)), priv));
}

/**
 * Verifies a request signature against a registered device public key.
 * Returns false for every failure — bad signature, wrong key, malformed input —
 * and never throws, so a caller cannot distinguish them by exception type.
 */
export async function verifyRequest(
  pub: Uint8Array,
  signature: string,
  req: RequestToSign,
): Promise<boolean> {
  if (pub.length !== PUBLIC_BYTES) return false;
  const sig = fromBase64Url(signature);
  if (sig === undefined || sig.length !== SIGNATURE_BYTES) return false;
  try {
    return ed25519.verify(sig, utf8.encode(signingString(req)), pub);
  } catch {
    return false;
  }
}
