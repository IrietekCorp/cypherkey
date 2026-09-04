import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { getFeatureRanges } from '../../../core/biometrics/features';
import { adapt } from '../../../core/biometrics/score';
import type { Profile } from '../../../core/biometrics/score';
import { verifyRequest } from '../../../core/crypto/device';
import { fromBase64Url, utf8Encode } from '../../../core/crypto/encoding';
import { budget } from '../../../core/crypto/phantom';
import type { Strictness } from '../../../core/crypto/phantom';
import { clearLockout, recordFailure } from '../auth/lockout';
import { issueSession } from '../auth/session-tokens';
import { scoreAligned } from '../biometrics/score';
import type { Config } from '../config';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';
import { MAX_SEQUENCE, alignCommitments } from '../phantom/align';
import { consumeBackupCode } from './backup-codes';

const MAX_SKEW_MS = 30_000;
/** How long a grey attempt stays open for its retype (X-3: "type it once more"). */
const PENDING_WINDOW_MS = 5 * 60_000;

/** A malformed commitment cannot match anything, so it aligns as a mismatch. */
function decodeCommitment(value: string): Uint8Array {
  try {
    return fromBase64Url(value);
  } catch {
    return new Uint8Array(0);
  }
}

const retypeSchema = z.object({
  username: z.string().min(1).max(64),
  authHash: z.string().min(1).max(512),
  method: z.literal('retype'),
  featureVector: z.array(z.number().finite()).min(1).max(4096),
  commitments: z.array(z.string().min(1).max(64)).min(1).max(MAX_SEQUENCE),
});

/** X-3: one of the ten one-time Backup Codes. It opens a session, never the vault. */
const backupCodeSchema = z.object({
  username: z.string().min(1).max(64),
  authHash: z.string().min(1).max(512),
  method: z.literal('backup_code'),
  proof: z.string().min(1).max(64),
});

const stepUpSchema = z.discriminatedUnion('method', [retypeSchema, backupCodeSchema]);

export type StepUpDeps = { db: Db; config: Config; timingFloorMs: number; now?: () => number };

async function withFloor<T>(floorMs: number, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await work();
  const remaining = floorMs - (performance.now() - started);
  if (remaining > 0) await Bun.sleep(remaining);
  return result;
}

/**
 * `POST /auth/step-up` — the second half of X-3's ladder.
 *
 * Two factors exist: `retype`, a second scored sample, and `backup_code`, one of the
 * ten one-time codes from X-3. Passkey and TOTP are M3. The route rejects any other
 * method rather than pretending to support it.
 *
 * An earlier note here claimed a code "cannot be checked server-side without breaking
 * zero-knowledge". That conflated two different objects. The **Recovery Kit** derives
 * `recoveryKey` and unwraps the vault, so the server must hold nothing that helps guess
 * it. A **Backup Code** derives nothing and unwraps nothing — it only proves "it is me"
 * to the server, and the vault still needs the passphrase. Verifying one server-side
 * costs no confidentiality.
 *
 * Like `/auth/refresh`, this cannot require an access token — a grey login issues
 * none. It re-proves the passphrase and the device signature instead.
 */
export function stepUpRoutes(deps: StepUpDeps): Hono {
  const app = new Hono();
  const { db, config } = deps;
  const now = deps.now ?? Date.now;

  const q = {
    userByName: async (username: string) =>
      (db.dialect === 'sqlite'
        ? await db.drizzle
            .select()
            .from(sqliteSchema.users)
            .where(eq(sqliteSchema.users.username, username))
        : await db.drizzle
            .select()
            .from(pgSchema.users)
            .where(eq(pgSchema.users.username, username)))[0],
    deviceByKey: async (publicKey: string) =>
      (db.dialect === 'sqlite'
        ? await db.drizzle
            .select()
            .from(sqliteSchema.devices)
            .where(eq(sqliteSchema.devices.publicKey, publicKey))
        : await db.drizzle
            .select()
            .from(pgSchema.devices)
            .where(eq(pgSchema.devices.publicKey, publicKey)))[0],
    profile: async (userId: string) =>
      (db.dialect === 'sqlite'
        ? await db.drizzle
            .select()
            .from(sqliteSchema.biometricProfiles)
            .where(eq(sqliteSchema.biometricProfiles.userId, userId))
        : await db.drizzle
            .select()
            .from(pgSchema.biometricProfiles)
            .where(eq(pgSchema.biometricProfiles.userId, userId)))[0],
    lastScore: async (userId: string) =>
      (db.dialect === 'sqlite'
        ? await db.drizzle
            .select()
            .from(sqliteSchema.authScoreHistory)
            .where(eq(sqliteSchema.authScoreHistory.userId, userId))
            .orderBy(desc(sqliteSchema.authScoreHistory.createdAt))
            .limit(1)
        : await db.drizzle
            .select()
            .from(pgSchema.authScoreHistory)
            .where(eq(pgSchema.authScoreHistory.userId, userId))
            .orderBy(desc(pgSchema.authScoreHistory.createdAt))
            .limit(1))[0],
  };

  app.post('/auth/step-up', async (c) => {
    const rawBody = await c.req.text();
    const headers = c.req.raw.headers;

    return withFloor(deps.timingFloorMs, async () => {
      let raw: unknown;
      try {
        raw = JSON.parse(rawBody);
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = stepUpSchema.safeParse(raw);
      // An unsupported method is 400, not 401: it is a client bug, not a bad secret.
      if (!parsed.success) return c.json({ error: 'unsupported_method' }, 400);
      const input = parsed.data;

      const deny = () => c.json({ error: 'invalid_credentials' }, 401);

      const user = await q.userByName(input.username);
      if (user === undefined) return deny();
      if (!(await Bun.password.verify(input.authHash, user.authHash))) return deny();

      const deviceKey = headers.get('x-cypherkey-device');
      const nonceRaw = headers.get('x-cypherkey-nonce');
      const tsRaw = headers.get('x-cypherkey-ts');
      const signature = headers.get('x-cypherkey-signature');
      if (deviceKey === null || nonceRaw === null || tsRaw === null || signature === null)
        return deny();
      const ts = Number(tsRaw);
      if (!Number.isInteger(ts) || Math.abs(now() - ts) > MAX_SKEW_MS) return deny();

      // A new device signs with the key it is asking us to trust, which proves
      // possession; the passphrase above is what proves it is this account's device.
      let signerKey: Uint8Array;
      let nonceBytes: Uint8Array;
      try {
        signerKey = fromBase64Url(deviceKey);
        nonceBytes = fromBase64Url(nonceRaw);
      } catch {
        return deny();
      }
      const url = new URL(c.req.url);
      const signatureOk = await verifyRequest(signerKey, signature, {
        nonce: nonceBytes,
        ts,
        method: 'POST',
        path: url.pathname + url.search,
        body: utf8Encode(rawBody),
      });
      if (!signatureOk) return deny();

      const existing = await q.deviceByKey(deviceKey);
      if (existing !== undefined && (existing.userId !== user.id || existing.revokedAt !== null)) {
        return deny();
      }

      const fail = async () => {
        // M2-00e: a failed step-up now counts toward lockout. It did not before, so a
        // bearer secret was guessable at the rate limit's ten a minute.
        await recordFailure(db, user.id, now());
      };

      const profile = await q.profile(user.id);
      let combined: number | null = null;

      if (input.method === 'backup_code') {
        // X-3: a one-time code clears the band on its own. There is no sample to score
        // and nothing to fold into the profile — the code proves identity, not rhythm.
        if (!(await consumeBackupCode(db, user.id, input.proof, now()))) {
          await fail();
          return c.json({ band: 'fail', error: 'step_up_failed' }, 401);
        }
      } else if (profile !== undefined && user.biometricEnabled) {
        const loginLen = input.commitments.length;
        if (input.featureVector.length !== getFeatureRanges(loginLen).totalLength) {
          return deny();
        }

        // A step-up is a second chance at the rhythm, never at the script: the same
        // A-14.3 budget applies, or a retype would be a way around the phantoms.
        const level: Strictness = user.thresholdsJson?.strictness ?? 'medium';
        const alignment = alignCommitments(
          profile.scriptCommitments.map(decodeCommitment),
          input.commitments.map(decodeCommitment),
        );
        const allowed = budget(level, profile.scriptLen);
        if (
          alignment.insertions > allowed.maxInsertions ||
          alignment.deletions + alignment.substitutions > allowed.maxMissing
        ) {
          await fail();
          return c.json({ band: 'fail', error: 'phantom_mismatch' }, 401);
        }

        const loaded: Profile = {
          version: 1,
          len: profile.scriptLen,
          means: profile.means,
          stds: profile.stds,
          weights: profile.weights,
          sampleCount: profile.sampleCount,
        };
        const sample = { version: 1 as const, len: loginLen, values: input.featureVector };
        const retype = scoreAligned(loaded, sample, alignment);

        // X-3: the grey band asks for a second sample and scores the average. A
        // pending grey attempt within the window is what this is completing.
        const pending = await q.lastScore(user.id);
        const isPending =
          pending !== undefined &&
          pending.band === 'grey' &&
          now() - pending.createdAt.getTime() <= PENDING_WINDOW_MS;
        combined = isPending ? (retype + pending.score) / 2 : retype;

        const row = {
          id: crypto.randomUUID(),
          userId: user.id,
          deviceId: existing?.id ?? null,
          score: combined,
          band: (combined >= config.scorePass ? 'pass' : 'fail') as 'pass' | 'fail',
          createdAt: new Date(now()),
        };
        if (db.dialect === 'sqlite')
          await db.drizzle.insert(sqliteSchema.authScoreHistory).values(row);
        else await db.drizzle.insert(pgSchema.authScoreHistory).values(row);

        if (combined < config.scorePass) {
          await fail();
          return c.json({ band: 'fail', error: 'step_up_failed' }, 401);
        }

        // X-3: a cleared step-up folds the sample into the profile — this is how the
        // profile learns a new keyboard. It deliberately bypasses the A-4.5 ten-minute
        // cap, because the passphrase and a second sample were both just proven.
        // Only an exact script feeds the profile, for the same reason as at login.
        const next = alignment.distance === 0 ? adapt(loaded, sample) : loaded;
        const update = {
          means: next.means,
          stds: next.stds,
          weights: next.weights,
          sampleCount: next.sampleCount,
          updatedAt: new Date(now()),
        };
        if (db.dialect === 'sqlite') {
          await db.drizzle
            .update(sqliteSchema.biometricProfiles)
            .set(update)
            .where(eq(sqliteSchema.biometricProfiles.userId, user.id));
        } else {
          await db.drizzle
            .update(pgSchema.biometricProfiles)
            .set(update)
            .where(eq(pgSchema.biometricProfiles.userId, user.id));
        }
      }

      // X-3: a new device is registered only once the step-up has cleared.
      let deviceId = existing?.id ?? null;
      if (existing === undefined) {
        deviceId = crypto.randomUUID();
        const row = {
          id: deviceId,
          userId: user.id,
          publicKey: deviceKey,
          name: 'New device',
          platform: 'unknown',
          trustedAt: new Date(now()),
          lastSeenAt: new Date(now()),
        };
        if (db.dialect === 'sqlite') await db.drizzle.insert(sqliteSchema.devices).values(row);
        else await db.drizzle.insert(pgSchema.devices).values(row);
      }

      await clearLockout(db, user.id);

      const issued = await issueSession(db, config, user.id, deviceId, now(), now());
      return c.json({
        band: 'pass',
        stepUp: true,
        score: combined,
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        wrappedVaultKey: user.wrappedVaultKey,
        serverShare: user.serverShare,
      });
    });
  });

  return app;
}
