import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { toBase64Url, utf8Encode } from '../../../core/crypto/encoding';

/**
 * Salted, one-way identifier for a value we must count but must not retain.
 * Used for IP addresses (A-9 stores `ip_hash`, never the address) and for rate-limit
 * bucket keys, so a database dump reveals neither who connected nor from where.
 */
export function saltedId(secret: string, scope: string, value: string): string {
  return toBase64Url(
    hmac(sha256, utf8Encode(secret), utf8Encode(`cypherkey/${scope}/v1:${value}`)),
  );
}

/**
 * The client address, as far as we can tell. `x-forwarded-for` is only trustworthy
 * behind our own proxy — Cloud Run and Cloudflare both set it — and a directly
 * reachable deployment can have it spoofed to defeat the per-IP bucket. That is
 * recorded in A-8 rather than papered over here.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first !== undefined && first.length > 0 ? first : 'unknown';
}
