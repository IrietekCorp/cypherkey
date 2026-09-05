import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { clearLockout, readLockout, recordFailure } from '../auth/lockout';
import { mintToken } from '../auth/token';
import type { Config } from '../config';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';

const ENROLLMENT_TOKEN_TTL_MS = 60 * 60_000;

const sealedSchema = z.object({
  ct: z.string().min(1).max(4096),
  nonce: z.string().min(1).max(64),
});

const beginSchema = z.object({
  username: z.string().min(1).max(64),
  recoveryAuthHash: z.string().min(1).max(512),
});

const recoverSchema = beginSchema.extend({
  newAuthHash: z.string().min(1).max(512),
  newUserSalt: z.string().min(1).max(512),
  newWrappedVaultKey: sealedSchema,
  devicePub: z.string().min(1).max(512),
  deviceName: z.string().min(1).max(64),
  devicePlatform: z.string().min(1).max(32),
});

export type RecoverDeps = { db: Db; config: Config; timingFloorMs: number; now?: () => number };

/** The same floor as `/auth/login`: an unknown user must cost what a wrong Kit costs. */
async function withFloor<T>(floorMs: number, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await work();
  const remaining = floorMs - (performance.now() - started);
  if (remaining > 0) await Bun.sleep(remaining);
  return result;
}

/**
 * `/auth/recover` — X-5, made real.
 *
 * `recoveryWrappedVaultKey` is the vault key wrapped under a key derived from the
 * Recovery Kit. An unauthenticated endpoint would hand that blob to anyone who could
 * name a username, turning the server into an oracle that distributes the encrypted
 * vault key on request. So both calls verify possession of the Kit *before releasing
 * anything*, and `begin` additionally writes nothing at all.
 */
export function recoverRoutes(deps: RecoverDeps): Hono {
  const app = new Hono();
  const { db, config } = deps;
  const now = deps.now ?? Date.now;

  const userByName = async (username: string) =>
    db.dialect === 'sqlite'
      ? (
          await db.drizzle
            .select()
            .from(sqliteSchema.users)
            .where(eq(sqliteSchema.users.username, username))
            .limit(1)
        )[0]
      : (
          await db.drizzle
            .select()
            .from(pgSchema.users)
            .where(eq(pgSchema.users.username, username))
            .limit(1)
        )[0];

  /**
   * Verifies the Kit. Returns the user, or null — the caller answers identically either
   * way, so an unknown username is indistinguishable from a wrong Kit.
   */
  async function authenticate(username: string, recoveryAuthHash: string) {
    const user = await userByName(username);
    if (user === undefined) {
      // Spend comparable time on an unknown user so the floor is not the only defence.
      await Bun.password.verify(recoveryAuthHash, DUMMY_ARGON_HASH).catch(() => false);
      return null;
    }
    const lockout = await readLockout(db, user.id);
    if (lockout?.lockedUntil != null && lockout.lockedUntil.getTime() > now()) {
      return { locked: true as const, user };
    }
    if (user.recoveryAuthHash === null) return null;
    if (!(await Bun.password.verify(recoveryAuthHash, user.recoveryAuthHash))) {
      await recordFailure(db, user.id, now());
      return null;
    }
    return { locked: false as const, user };
  }

  app.post('/auth/recover/begin', async (c) => {
    return withFloor(deps.timingFloorMs, async () => {
      let raw: unknown;
      try {
        raw = JSON.parse(await c.req.text());
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = beginSchema.safeParse(raw);
      if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

      const result = await authenticate(parsed.data.username, parsed.data.recoveryAuthHash);
      if (result === null) return c.json({ error: 'invalid_credentials' }, 401);
      if (result.locked) return c.json({ error: 'locked_out' }, 429);
      const { user } = result;
      if (user.recoveryWrappedVaultKey === null) {
        return c.json({ error: 'invalid_credentials' }, 401);
      }

      // Read-only, deliberately: no factor, device, key or profile is touched here.
      // The client cannot compute the new wrapped key until it has unwrapped the old
      // one, so this call exists purely to hand over material it has proved title to.
      return c.json({
        recoveryWrappedVaultKey: user.recoveryWrappedVaultKey,
        serverShare: user.serverShare,
      });
    });
  });

  app.post('/auth/recover', async (c) => {
    return withFloor(deps.timingFloorMs, async () => {
      let raw: unknown;
      try {
        raw = JSON.parse(await c.req.text());
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = recoverSchema.safeParse(raw);
      if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
      const input = parsed.data;

      const result = await authenticate(input.username, input.recoveryAuthHash);
      if (result === null) return c.json({ error: 'invalid_credentials' }, 401);
      if (result.locked) return c.json({ error: 'locked_out' }, 429);
      const { user } = result;

      const deviceId = crypto.randomUUID();
      const at = new Date(now());
      const userUpdate = {
        authHash: await Bun.password.hash(input.newAuthHash, { algorithm: 'argon2id' }),
        userSalt: input.newUserSalt,
        argonParams: config.argonParams,
        wrappedVaultKey: input.newWrappedVaultKey,
        keyVersion: user.keyVersion + 1,
      };
      const deviceRow = {
        id: deviceId,
        userId: user.id,
        publicKey: input.devicePub,
        name: input.deviceName,
        platform: input.devicePlatform,
        trustedAt: at,
        lastSeenAt: at,
        revokedAt: null,
      };

      /**
       * All of it commits or none of it does.
       *
       * The two branches are not stylistic. `bun:sqlite` is a *synchronous* driver, and
       * drizzle's sqlite `transaction()` given an async callback returns before the
       * promise settles — the writes then land outside transactional control and a
       * throw rolls back nothing. Measured, not assumed. So sqlite gets a synchronous
       * body with explicit `.run()`, and postgres gets the awaited one it needs.
       */
      try {
        if (db.dialect === 'sqlite') {
          const s = sqliteSchema;
          db.drizzle.transaction((tx) => {
            // 1. A-17: TOTP secrets were encrypted under a key derived from the passphrase
            // that has just been lost. They are unreachable, and leaving them behind would
            // lock the account out of its own recovery.
            tx.delete(s.stepUpFactors)
              .where(and(eq(s.stepUpFactors.userId, user.id), eq(s.stepUpFactors.type, 'totp')))
              .run();
            // 2. every device and every refresh token, revoked.
            tx.update(s.devices)
              .set({ revokedAt: at })
              .where(and(eq(s.devices.userId, user.id), isNull(s.devices.revokedAt)))
              .run();
            tx.update(s.refreshTokens)
              .set({ revokedAt: at })
              .where(and(eq(s.refreshTokens.userId, user.id), isNull(s.refreshTokens.revokedAt)))
              .run();
            // 3. register the device that presented the Kit.
            tx.insert(s.devices).values(deviceRow).run();
            // 4. the new passphrase material, and a key-version bump.
            tx.update(s.users).set(userUpdate).where(eq(s.users.id, user.id)).run();
            // 5. X-5 requires a fresh enrolment: the old rhythm profile goes.
            tx.delete(s.biometricProfiles).where(eq(s.biometricProfiles.userId, user.id)).run();
            tx.delete(s.enrollmentSamples).where(eq(s.enrollmentSamples.userId, user.id)).run();
            // 6. Backup Codes are left alone: sha256 hashes that owe nothing to the passphrase.
          });
        } else {
          const p = pgSchema;
          await db.drizzle.transaction(async (tx) => {
            await tx
              .delete(p.stepUpFactors)
              .where(and(eq(p.stepUpFactors.userId, user.id), eq(p.stepUpFactors.type, 'totp')));
            await tx
              .update(p.devices)
              .set({ revokedAt: at })
              .where(and(eq(p.devices.userId, user.id), isNull(p.devices.revokedAt)));
            await tx
              .update(p.refreshTokens)
              .set({ revokedAt: at })
              .where(and(eq(p.refreshTokens.userId, user.id), isNull(p.refreshTokens.revokedAt)));
            await tx.insert(p.devices).values(deviceRow);
            await tx.update(p.users).set(userUpdate).where(eq(p.users.id, user.id));
            await tx.delete(p.biometricProfiles).where(eq(p.biometricProfiles.userId, user.id));
            await tx.delete(p.enrollmentSamples).where(eq(p.enrollmentSamples.userId, user.id));
          });
        }
      } catch {
        // The transaction rolled back, so the account is exactly as it was. Say so
        // plainly rather than leaking a driver error, and do not count it as a failed
        // Kit — the Kit was correct; something else went wrong.
        return c.json({ error: 'recovery_failed' }, 500);
      }

      await clearLockout(db, user.id);

      // `vaultKey` itself never changed, so the vault is not re-encrypted. What changed
      // is the passphrase that wraps the client's half of it.
      return c.json({
        userId: user.id,
        serverShare: user.serverShare,
        enrollmentToken: mintToken(
          { sub: user.id, scope: 'enroll' },
          config.jwtSecret,
          now(),
          ENROLLMENT_TOKEN_TTL_MS,
        ),
      });
    });
  });

  return app;
}

/**
 * A real Argon2id hash of a value nobody holds, so an unknown username costs roughly
 * what a wrong Kit costs. Generated once at module load.
 */
const DUMMY_ARGON_HASH = await Bun.password.hash(crypto.randomUUID(), { algorithm: 'argon2id' });
