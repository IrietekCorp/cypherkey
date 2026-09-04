import { eq } from 'drizzle-orm';
import { verifyRequest } from '../../../core/crypto/device';
import { fromBase64Url, utf8Encode } from '../../../core/crypto/encoding';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';

/** A-3: ±30 s of clock skew is tolerated. */
const MAX_SKEW_MS = 30_000;

export type SignedRequestParts = {
  method: string;
  path: string;
  rawBody: string;
  headers: Headers;
};

export type VerifiedDevice = { userId: string; deviceId: string };

/**
 * Verifies the A-3 device signature carried in the `x-cypherkey-*` headers.
 * Returns the owning user, or null for every failure — a caller cannot tell a
 * missing header from a bad signature from an unknown device.
 *
 * Replay: not covered here. The one route using this today is one-shot and
 * answers 409 on a second attempt, so a replayed request changes nothing. The
 * shared nonce log of A-3 lands with the middleware in M1-09/M1-14.
 */
export async function verifyDeviceSignature(
  db: Db,
  parts: SignedRequestParts,
  now: number = Date.now(),
): Promise<VerifiedDevice | null> {
  const deviceId = parts.headers.get('x-cypherkey-device');
  const nonceRaw = parts.headers.get('x-cypherkey-nonce');
  const tsRaw = parts.headers.get('x-cypherkey-ts');
  const signature = parts.headers.get('x-cypherkey-signature');
  if (deviceId === null || nonceRaw === null || tsRaw === null || signature === null) return null;

  const ts = Number(tsRaw);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return null;

  let nonce: Uint8Array;
  try {
    nonce = fromBase64Url(nonceRaw);
  } catch {
    return null;
  }

  const devices =
    db.dialect === 'sqlite'
      ? await db.drizzle
          .select()
          .from(sqliteSchema.devices)
          .where(eq(sqliteSchema.devices.publicKey, deviceId))
      : await db.drizzle
          .select()
          .from(pgSchema.devices)
          .where(eq(pgSchema.devices.publicKey, deviceId));

  const device = devices[0];
  if (device === undefined || device.revokedAt !== null || device.userId === null) return null;

  let publicKey: Uint8Array;
  try {
    publicKey = fromBase64Url(device.publicKey);
  } catch {
    return null;
  }

  const ok = await verifyRequest(publicKey, signature, {
    nonce,
    ts,
    method: parts.method,
    path: parts.path,
    body: utf8Encode(parts.rawBody),
  });
  return ok ? { userId: device.userId, deviceId: device.id } : null;
}
