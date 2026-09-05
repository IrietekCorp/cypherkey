import { eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';
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

/**
 * A-17 re-auth: the passphrase must travel in *this* request.
 *
 * This replaces the `stepUpAt` claim M1-13 shipped — an access token flagged as
 * step-up-fresh for five minutes. That check was weaker in two ways. It proved only
 * that a step-up happened recently, so anyone holding an unlocked popup within the
 * window could weaken the account's protection; and, decisively, a claim cannot produce
 * `stepUpKey`, so a route that must re-wrap a TOTP secret (A-17) had nothing to do it
 * with. Verifying `authHash` here gives both.
 *
 * Returns the user row when the passphrase matches, so callers do not fetch it twice.
 */
export async function requireReauth(
  db: Db,
  userId: string,
  authHash: string,
): Promise<{ id: string; authHash: string; keyVersion: number } | null> {
  const rows =
    db.dialect === 'sqlite'
      ? await db.drizzle
          .select()
          .from(sqliteSchema.users)
          .where(eq(sqliteSchema.users.id, userId))
          .limit(1)
      : await db.drizzle
          .select()
          .from(pgSchema.users)
          .where(eq(pgSchema.users.id, userId))
          .limit(1);

  const user = rows[0];
  if (user === undefined) return null;
  if (!(await Bun.password.verify(authHash, user.authHash))) return null;
  return { id: user.id, authHash: user.authHash, keyVersion: user.keyVersion };
}
