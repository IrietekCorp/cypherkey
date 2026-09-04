import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { equalBytes, fromBase64Url, toBase64Url, utf8Encode } from '../../../core/crypto/encoding';

/**
 * Token scopes. A-9 removed the `enroll_tokens` table in favour of scoped tokens,
 * so the scope is what limits a token rather than which table it came from.
 */
export type TokenScope = 'enroll' | 'access';

export type TokenClaims = {
  sub: string;
  scope: TokenScope;
  iat: number;
  exp: number;
  /**
   * When the holder last cleared a step-up, if ever. Settings that weaken the
   * biometric (X-4 Pause, disabling it, changing Strictness) require this to be
   * recent, so an attacker holding only the passphrase cannot switch the rhythm off.
   */
  stepUpAt?: number;
};

/** A-8: HS256 over `JWT_SECRET`. Written out rather than pulling in a JWT library. */
function sign(input: string, secret: string): string {
  return toBase64Url(hmac(sha256, utf8Encode(secret), utf8Encode(input)));
}

/** Mints a scoped token valid for `ttlMs` from `now`. */
/** How recently a step-up must have happened for it to still authorise a change. */
export const STEP_UP_FRESHNESS_MS = 5 * 60_000;

/** True when the token carries a step-up that is still fresh. */
export function hasFreshStepUp(claims: TokenClaims, now: number): boolean {
  return claims.stepUpAt !== undefined && now - claims.stepUpAt <= STEP_UP_FRESHNESS_MS;
}

export function mintToken(
  claims: Omit<TokenClaims, 'iat' | 'exp'>,
  secret: string,
  now: number,
  ttlMs: number,
): string {
  const header = toBase64Url(utf8Encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = toBase64Url(
    utf8Encode(JSON.stringify({ ...claims, iat: now, exp: now + ttlMs })),
  );
  return `${header}.${payload}.${sign(`${header}.${payload}`, secret)}`;
}

/**
 * Verifies a token and returns its claims, or null for every failure — bad shape,
 * bad signature, expired, or the wrong scope. The signature is compared in constant
 * time, and no failure says which check failed.
 */
export function verifyToken(
  token: string,
  secret: string,
  scope: TokenScope,
  now: number,
): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];

  let provided: Uint8Array;
  let expected: Uint8Array;
  try {
    provided = fromBase64Url(signature);
    expected = fromBase64Url(sign(`${header}.${payload}`, secret));
  } catch {
    return null;
  }
  if (!equalBytes(provided, expected)) return null;

  let claims: TokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as TokenClaims;
  } catch {
    return null;
  }
  if (typeof claims.sub !== 'string' || claims.scope !== scope) return null;
  if (!Number.isInteger(claims.exp) || claims.exp <= now) return null;
  return claims;
}

/** Reads a bearer token out of an Authorization header. */
export function bearerToken(headers: Headers): string | null {
  const raw = headers.get('authorization');
  if (raw === null) return null;
  const match = /^Bearer (.+)$/.exec(raw);
  return match?.[1] ?? null;
}
