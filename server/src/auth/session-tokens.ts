import { sha256 } from '@noble/hashes/sha2';
import { toBase64Url, utf8Encode } from '../../../core/crypto/encoding';
import { randomBytes } from '../../../core/crypto/kdf';
import type { Config } from '../config';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';
import { mintToken } from './token';

/** A-8: 15-minute access token, 30-day rotating refresh token. */
export const ACCESS_TTL_MS = 15 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;

/** Refresh tokens are stored as a hash, so a DB dump cannot be replayed as a session. */
export function hashRefreshToken(token: string): string {
  return toBase64Url(sha256(utf8Encode(token)));
}

export type IssuedSession = { accessToken: string; refreshToken: string; refreshTokenId: string };

/**
 * Mints an access/refresh pair and records the refresh token by hash. Shared by
 * login and by rotation so the two cannot drift apart.
 */
export async function issueSession(
  db: Db,
  config: Config,
  userId: string,
  deviceId: string | null,
  now: number,
): Promise<IssuedSession> {
  const accessToken = mintToken(
    { sub: userId, scope: 'access' },
    config.jwtSecret,
    now,
    ACCESS_TTL_MS,
  );
  const refreshToken = toBase64Url(randomBytes(32));
  const refreshTokenId = crypto.randomUUID();
  const row = {
    id: refreshTokenId,
    userId,
    deviceId,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt: new Date(now + REFRESH_TTL_MS),
  };
  if (db.dialect === 'sqlite') await db.drizzle.insert(sqliteSchema.refreshTokens).values(row);
  else await db.drizzle.insert(pgSchema.refreshTokens).values(row);
  return { accessToken, refreshToken, refreshTokenId };
}
