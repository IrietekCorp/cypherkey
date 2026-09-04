import type { Config } from '../config';
import type { Db } from '../db/client';
import { verifyDeviceSignature } from './signature';
import { bearerToken, verifyToken } from './token';

export type Authenticated = { userId: string; deviceId: string };

export type IncomingRequest = { url: string; method: string; raw: Request };

/**
 * A-10: every route beyond salt/signup/login/healthz needs an access token **and**
 * a device signature. Returns null for every failure so the caller answers 401
 * without revealing which check failed.
 */
export async function requireAuth(
  db: Db,
  config: Config,
  req: IncomingRequest,
  rawBody: string,
  now: number,
): Promise<Authenticated | null> {
  const token = bearerToken(req.raw.headers);
  if (token === null) return null;
  const claims = verifyToken(token, config.jwtSecret, 'access', now);
  if (claims === null) return null;

  const url = new URL(req.url);
  const verified = await verifyDeviceSignature(
    db,
    { method: req.method, path: url.pathname + url.search, rawBody, headers: req.raw.headers },
    now,
  );
  // The token names a user, the signature names a device; they must agree.
  if (verified === null || verified.userId !== claims.sub) return null;
  return { userId: claims.sub, deviceId: verified.deviceId };
}
