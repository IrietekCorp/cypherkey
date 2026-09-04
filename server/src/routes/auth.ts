import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { fromBase64Url, toBase64Url, utf8Encode } from '../../../core/crypto/encoding';
import { randomBytes } from '../../../core/crypto/kdf';
import { verifyDeviceSignature } from '../auth/signature';
import { mintToken } from '../auth/token';
import type { Config } from '../config';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

/** Long enough to finish onboarding in one sitting (X-2 targets under 3 minutes). */
const ENROLLMENT_TOKEN_TTL_MS = 60 * 60_000;

/** A base64url string that decodes to exactly `bytes` bytes. */
function b64url(bytes?: number) {
  return z.string().refine(
    (value) => {
      try {
        const decoded = fromBase64Url(value);
        return bytes === undefined ? decoded.length > 0 : decoded.length === bytes;
      } catch {
        return false;
      }
    },
    { message: bytes === undefined ? 'expected base64url' : `expected ${bytes} base64url bytes` },
  );
}

const sealedSchema = z.object({ ct: b64url(), nonce: b64url(NONCE_BYTES) });

const signupSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/),
  email: z.string().email(),
  authHash: b64url(KEY_BYTES),
  userSalt: b64url(SALT_BYTES),
  wrappedVaultKey: sealedSchema,
  devicePub: b64url(KEY_BYTES),
  deviceName: z.string().min(1).max(64),
  devicePlatform: z.string().min(1).max(32),
  consentAt: z.number().int().positive(),
  consentPolicyVersion: z.string().min(1).max(32),
});

const recoveryKeySchema = z.object({ recoveryWrappedVaultKey: sealedSchema });

export type AuthDeps = {
  db: Db;
  config: Config;
  /** A-5: every auth response is padded to this floor. Tests set it to 0. */
  timingFloorMs: number;
  now?: () => number;
};

/** Runs `work`, then waits out the remainder of the timing floor (A-5). */
async function withFloor<T>(floorMs: number, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await work();
  const remaining = floorMs - (performance.now() - started);
  if (remaining > 0) await Bun.sleep(remaining);
  return result;
}

/**
 * The salt handed out for a username that does not exist. Deterministic per username
 * and keyed to the server secret, so an attacker cannot tell a real account from an
 * invented one, cannot precompute the answer, and gets the same answer every time.
 */
function fakeSalt(username: string, serverSecret: string): string {
  const mac = hmac(
    sha256,
    utf8Encode(serverSecret),
    utf8Encode(`cypherkey/salt-oracle/v1:${username}`),
  );
  return toBase64Url(mac.slice(0, SALT_BYTES));
}

export function authRoutes(deps: AuthDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const { db, config } = deps;

  app.get('/auth/salt', async (c) => {
    const username = c.req.query('username');
    if (username === undefined || username.length === 0) {
      return c.json({ error: 'username_required' }, 400);
    }

    return withFloor(deps.timingFloorMs, async () => {
      const rows =
        db.dialect === 'sqlite'
          ? await db.drizzle
              .select()
              .from(sqliteSchema.users)
              .where(eq(sqliteSchema.users.username, username))
          : await db.drizzle
              .select()
              .from(pgSchema.users)
              .where(eq(pgSchema.users.username, username));
      const user = rows[0];

      if (user === undefined) {
        // Same shape, same status, same timing as a real account.
        return c.json({
          userSalt: fakeSalt(username, config.jwtSecret),
          argonParams: config.argonParams,
          deviceRegistered: false,
        });
      }

      const devices =
        db.dialect === 'sqlite'
          ? await db.drizzle
              .select()
              .from(sqliteSchema.devices)
              .where(eq(sqliteSchema.devices.userId, user.id))
          : await db.drizzle
              .select()
              .from(pgSchema.devices)
              .where(eq(pgSchema.devices.userId, user.id));

      return c.json({
        userSalt: user.userSalt,
        argonParams: user.argonParams,
        deviceRegistered: devices.some((d) => d.revokedAt === null),
      });
    });
  });

  app.post('/auth/signup', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = signupSchema.safeParse(raw);
    if (!parsed.success) {
      // Field names only — never the submitted values, which include key material.
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
      return c.json({ error: 'invalid_body', fields }, 400);
    }
    const input = parsed.data;

    return withFloor(deps.timingFloorMs, async () => {
      const existing =
        db.dialect === 'sqlite'
          ? await db.drizzle
              .select()
              .from(sqliteSchema.users)
              .where(eq(sqliteSchema.users.username, input.username))
          : await db.drizzle
              .select()
              .from(pgSchema.users)
              .where(eq(pgSchema.users.username, input.username));
      if (existing.length > 0) {
        return c.json({ error: 'username_taken' }, 409);
      }

      const userId = crypto.randomUUID();
      const serverShare = toBase64Url(randomBytes(KEY_BYTES));
      // A-2: the DB stores Argon2id(authHash), so a dump cannot be replayed as a login.
      const authHash = await Bun.password.hash(input.authHash, { algorithm: 'argon2id' });
      const createdAt = new Date(now());

      const userRow = {
        id: userId,
        username: input.username,
        email: input.email,
        userSalt: input.userSalt,
        argonParams: config.argonParams,
        authHash,
        wrappedVaultKey: input.wrappedVaultKey,
        serverShare,
        consentAt: new Date(input.consentAt),
        consentPolicyVersion: input.consentPolicyVersion,
        createdAt,
      };
      const deviceRow = {
        id: crypto.randomUUID(),
        userId,
        publicKey: input.devicePub,
        name: input.deviceName,
        platform: input.devicePlatform,
        trustedAt: createdAt,
        lastSeenAt: createdAt,
      };

      try {
        if (db.dialect === 'sqlite') {
          await db.drizzle.insert(sqliteSchema.users).values(userRow);
          await db.drizzle.insert(sqliteSchema.devices).values(deviceRow);
        } else {
          await db.drizzle.insert(pgSchema.users).values(userRow);
          await db.drizzle.insert(pgSchema.devices).values(deviceRow);
        }
      } catch {
        // Lost a race on the unique index, or the device insert failed.
        return c.json({ error: 'username_taken' }, 409);
      }

      // A-9 replaced the enroll_tokens table with scoped tokens; /enroll/* needs this
      // one plus the device signature.
      const enrollmentToken = mintToken(
        { sub: userId, scope: 'enroll' },
        config.jwtSecret,
        now(),
        ENROLLMENT_TOKEN_TTL_MS,
      );
      return c.json({ userId, serverShare, enrollmentToken }, 201);
    });
  });

  // A-5 second leg: the client can only wrap the full vaultKey once serverShare has
  // arrived, so this cannot be part of the signup body. Authenticated by the device
  // signature of the key registered moments earlier (A-3), never anonymous.
  app.post('/auth/recovery-key', async (c) => {
    const rawBody = await c.req.text();

    return withFloor(deps.timingFloorMs, async () => {
      const url = new URL(c.req.url);
      const verified = await verifyDeviceSignature(
        db,
        { method: 'POST', path: url.pathname + url.search, rawBody, headers: c.req.raw.headers },
        now(),
      );
      if (verified === null) {
        return c.json({ error: 'unauthorized' }, 401);
      }

      let raw: unknown;
      try {
        raw = JSON.parse(rawBody);
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = recoveryKeySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid_body' }, 400);
      }

      const rows =
        db.dialect === 'sqlite'
          ? await db.drizzle
              .select()
              .from(sqliteSchema.users)
              .where(eq(sqliteSchema.users.id, verified.userId))
          : await db.drizzle
              .select()
              .from(pgSchema.users)
              .where(eq(pgSchema.users.id, verified.userId));
      const user = rows[0];
      if (user === undefined) return c.json({ error: 'unauthorized' }, 401);

      // One-shot. Overwriting would let anyone holding the device swap the Recovery
      // Kit for one they control, which is a silent account takeover.
      if (user.recoveryWrappedVaultKey !== null) {
        return c.json({ error: 'already_registered' }, 409);
      }

      const value = { recoveryWrappedVaultKey: parsed.data.recoveryWrappedVaultKey };
      if (db.dialect === 'sqlite') {
        await db.drizzle
          .update(sqliteSchema.users)
          .set(value)
          .where(eq(sqliteSchema.users.id, user.id));
      } else {
        await db.drizzle.update(pgSchema.users).set(value).where(eq(pgSchema.users.id, user.id));
      }
      return c.json({ ok: true }, 200);
    });
  });

  return app;
}
