import { eq, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { getFeatureRanges } from '../../../core/biometrics/features';
import { adapt, band as bandOf } from '../../../core/biometrics/score';
import type { Profile } from '../../../core/biometrics/score';
import { verifyRequest } from '../../../core/crypto/device';
import { fromBase64Url, utf8Encode } from '../../../core/crypto/encoding';
import { budget, rhythmBands } from '../../../core/crypto/phantom';
import type { Strictness } from '../../../core/crypto/phantom';
import { issueSession } from '../auth/session-tokens';
import { mintToken } from '../auth/token';
import { scoreAligned } from '../biometrics/score';
import type { Config } from '../config';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';
import type { Mailer } from '../mail/client';
import { MAX_SEQUENCE, alignCommitments } from '../phantom/align';

/** A-3: ±30 s of clock skew. */
const MAX_SKEW_MS = 30_000;
/** X-3: five failures, then 15 minutes doubling each time. */
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BASE_MS = 15 * 60_000;
/** A-4.5: adapt only above this score, and at most once per window. */
const ADAPT_MIN_SCORE = 0.7;
const ADAPT_WINDOW_MS = 10 * 60_000;
/** X-3 ladder. Passkey and TOTP land in M3; recovery codes are the M2 default. */
const STEP_UP_METHODS = ['retype', 'recovery_code'] as const;

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  authHash: z.string().min(1).max(512),
  featureVector: z.array(z.number().finite()).min(1).max(4096),
  /** A-14.2: the script commitments for this attempt, in order. */
  commitments: z.array(z.string().min(1).max(64)).min(1).max(MAX_SEQUENCE),
});

export type LoginDeps = {
  db: Db;
  config: Config;
  timingFloorMs: number;
  now?: () => number;
  /**
   * X-3's failure notice. Optional so a self-hosted instance with no mail provider
   * simply does not send one, rather than failing logins it cannot email about.
   */
  mailer?: Mailer;
};

/** Matches signup's: an hour is enough to type eight samples, and no longer. */
const ENROLLMENT_TOKEN_TTL_MS = 60 * 60_000;

/** A malformed commitment cannot match anything, so it aligns as a mismatch. */
function decodeCommitment(value: string): Uint8Array {
  try {
    return fromBase64Url(value);
  } catch {
    return new Uint8Array(0);
  }
}

async function withFloor<T>(floorMs: number, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await work();
  const remaining = floorMs - (performance.now() - started);
  if (remaining > 0) await Bun.sleep(remaining);
  return result;
}

export function loginRoutes(deps: LoginDeps): Hono {
  const app = new Hono();
  const { db, config } = deps;
  const now = deps.now ?? Date.now;
  // Each query is written once per dialect: the two Drizzle builders are different
  // types, so a shared handle cannot be passed to both.
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
    lockout: async (userId: string) =>
      (db.dialect === 'sqlite'
        ? await db.drizzle
            .select()
            .from(sqliteSchema.lockouts)
            .where(eq(sqliteSchema.lockouts.userId, userId))
        : await db.drizzle
            .select()
            .from(pgSchema.lockouts)
            .where(eq(pgSchema.lockouts.userId, userId)))[0],
  };

  /** Records a nonce, returning false if it has been seen — A-3 replay defence. */
  async function claimNonce(nonce: string, userId: string): Promise<boolean> {
    const cutoff = new Date(now() - 5 * 60_000);
    try {
      if (db.dialect === 'sqlite') {
        await db.drizzle.delete(sqliteSchema.nonces).where(lt(sqliteSchema.nonces.seenAt, cutoff));
        await db.drizzle
          .insert(sqliteSchema.nonces)
          .values({ nonce, userId, seenAt: new Date(now()) });
      } else {
        await db.drizzle.delete(pgSchema.nonces).where(lt(pgSchema.nonces.seenAt, cutoff));
        await db.drizzle.insert(pgSchema.nonces).values({ nonce, userId, seenAt: new Date(now()) });
      }
      return true;
    } catch {
      // Primary-key collision: this nonce has already been spent.
      return false;
    }
  }

  async function upsertLockout(userId: string, failedCount: number, lockedUntil: Date | null) {
    const row = { userId, failedCount, lockedUntil };
    const existing = await q.lockout(userId);
    if (db.dialect === 'sqlite') {
      if (existing === undefined) await db.drizzle.insert(sqliteSchema.lockouts).values(row);
      else
        await db.drizzle
          .update(sqliteSchema.lockouts)
          .set({ failedCount, lockedUntil })
          .where(eq(sqliteSchema.lockouts.userId, userId));
    } else {
      if (existing === undefined) await db.drizzle.insert(pgSchema.lockouts).values(row);
      else
        await db.drizzle
          .update(pgSchema.lockouts)
          .set({ failedCount, lockedUntil })
          .where(eq(pgSchema.lockouts.userId, userId));
    }
  }

  /** X-3: counts a failure and locks for 15 minutes, doubling on each further lock. */
  async function recordFailure(userId: string): Promise<void> {
    const existing = await q.lockout(userId);
    const failedCount = (existing?.failedCount ?? 0) + 1;
    const locks = Math.floor(failedCount / LOCKOUT_THRESHOLD);
    const lockedUntil =
      failedCount >= LOCKOUT_THRESHOLD && failedCount % LOCKOUT_THRESHOLD === 0
        ? new Date(now() + LOCKOUT_BASE_MS * 2 ** (locks - 1))
        : (existing?.lockedUntil ?? null);
    await upsertLockout(userId, failedCount, lockedUntil);
  }

  async function recordScore(
    userId: string,
    deviceId: string | null,
    score: number,
    bandName: string,
  ) {
    const row = {
      id: crypto.randomUUID(),
      userId,
      deviceId,
      score,
      band: bandName as 'pass' | 'grey' | 'fail',
      createdAt: new Date(now()),
    };
    if (db.dialect === 'sqlite') await db.drizzle.insert(sqliteSchema.authScoreHistory).values(row);
    else await db.drizzle.insert(pgSchema.authScoreHistory).values(row);
  }

  app.post('/auth/login', async (c) => {
    const rawBody = await c.req.text();
    const headers = c.req.raw.headers;

    return withFloor(deps.timingFloorMs, async () => {
      let raw: unknown;
      try {
        raw = JSON.parse(rawBody);
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = loginSchema.safeParse(raw);
      if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
      const input = parsed.data;

      // Every rejection below answers the same way. A caller must not be able to
      // tell an unknown user from a bad passphrase from a spent nonce.
      const deny = () => c.json({ error: 'invalid_credentials' }, 401);

      const user = await q.userByName(input.username);
      if (user === undefined) return deny();

      const lockout = await q.lockout(user.id);
      if (lockout?.lockedUntil != null && lockout.lockedUntil.getTime() > now()) {
        return c.json({ error: 'locked_out' }, 429);
      }

      // A-5 step 4, first gate: the passphrase. A wrong one never reaches scoring.
      if (!(await Bun.password.verify(input.authHash, user.authHash))) {
        await recordFailure(user.id);
        return deny();
      }

      // A-5 step 4, second gate: the device signature.
      const deviceKey = headers.get('x-cypherkey-device');
      const nonceRaw = headers.get('x-cypherkey-nonce');
      const tsRaw = headers.get('x-cypherkey-ts');
      const signature = headers.get('x-cypherkey-signature');
      if (deviceKey === null || nonceRaw === null || tsRaw === null || signature === null) {
        return deny();
      }
      const ts = Number(tsRaw);
      if (!Number.isInteger(ts) || Math.abs(now() - ts) > MAX_SKEW_MS) return deny();

      const url = new URL(c.req.url);
      const device = await q.deviceByKey(deviceKey);
      const knownDevice =
        device !== undefined && device.revokedAt === null && device.userId === user.id;

      if (knownDevice) {
        let nonceBytes: Uint8Array;
        try {
          nonceBytes = fromBase64Url(nonceRaw);
        } catch {
          return deny();
        }
        const ok = await verifyRequest(fromBase64Url(device.publicKey), signature, {
          nonce: nonceBytes,
          ts,
          method: 'POST',
          path: url.pathname + url.search,
          body: utf8Encode(rawBody),
        });
        if (!ok) return deny();
        if (!(await claimNonce(nonceRaw, user.id))) return deny();
      }

      // X-3: a device we do not know always goes to step-up, whatever the rhythm.
      if (!knownDevice) {
        return c.json({ band: 'grey', newDevice: true, stepUp: [...STEP_UP_METHODS] });
      }

      const profile = await q.profile(user.id);
      const paused =
        user.biometricPausedUntil != null && user.biometricPausedUntil.getTime() > now();

      // Nothing to score against: a user mid-onboarding, or one who paused or
      // disabled the rhythm (X-4, X-9). The passphrase and the trusted device
      // still had to hold, and no score is invented for the history.
      if (profile === undefined || !user.biometricEnabled || paused) {
        await upsertLockout(user.id, 0, null);
        const { accessToken, refreshToken } = await issueSession(
          db,
          config,
          user.id,
          device.id,
          now(),
        );
        /*
          A user who signed up but never finished enrolling gets an enrollment token
          back, because otherwise there is no way to ever finish.

          `/enroll/*` needs an `enroll`-scoped token, and only signup issued one. It
          lived in the popup's memory, so closing the popup between samples stranded the
          account for good: the passphrase still worked, the device was still trusted,
          login still passed -- and the one screen that could complete the account could
          no longer authenticate to the server. The client had nothing to resume from.

          Only when there is no profile to score against. An enrolled user is not
          offered one, so this widens nothing for an account that is already complete,
          and the token still requires the device signature the login just proved.
        */
        const resumeEnrollment =
          profile === undefined
            ? {
                enrollmentToken: mintToken(
                  { sub: user.id, scope: 'enroll' },
                  config.jwtSecret,
                  now(),
                  ENROLLMENT_TOKEN_TTL_MS,
                ),
              }
            : {};
        return c.json({
          band: 'pass',
          enrolled: profile !== undefined,
          keyVersion: user.keyVersion,
          accessToken,
          refreshToken,
          wrappedVaultKey: user.wrappedVaultKey,
          serverShare: user.serverShare,
          ...resumeEnrollment,
        });
      }

      // The vector must describe the number of tokens the client says it typed.
      const loginLen = input.commitments.length;
      if (input.featureVector.length !== getFeatureRanges(loginLen).totalLength) return deny();

      // A-14.3 step 2: align the enrolled script against this attempt, counting
      // insertions and deletions separately.
      const level: Strictness = user.thresholdsJson?.strictness ?? 'medium';
      const canonical = profile.scriptCommitments.map(decodeCommitment);
      const alignment = alignCommitments(canonical, input.commitments.map(decodeCommitment));

      // A-14.3 step 3. A missing enrolled token is what someone holding only the
      // leaked resolved passphrase looks like, so it is budgeted apart from a fumble.
      const allowed = budget(level, profile.scriptLen);
      if (
        alignment.insertions > allowed.maxInsertions ||
        alignment.deletions + alignment.substitutions > allowed.maxMissing
      ) {
        await recordFailure(user.id);
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
      // A-14.3 step 4: score through the alignment path.
      const score = scoreAligned(loaded, sample, alignment);
      const thresholds = rhythmBands(level);
      const result = bandOf(score, thresholds.pass, thresholds.grey);

      await recordScore(user.id, device.id, score, result);

      if (result === 'fail') {
        await recordFailure(user.id);
        /**
         * X-3: the dark-web-breach email inverted. Someone had the passphrase and it
         * did not work, which is the clearest evidence a user ever gets that this
         * product did its job.
         *
         * Only on `fail`. A grey band is as often a bad day as an attacker, and
         * emailing about it would teach people to ignore the one that matters.
         */
        await deps.mailer?.notifyRhythmFailure(user.id, user.email);
        return c.json({ band: 'fail', error: 'rhythm_mismatch' }, 401);
      }
      if (result === 'grey') {
        // A grey band is not a failure — it is a different person's bad day as
        // often as an attacker, so it must not walk anyone toward a lockout.
        return c.json({ band: 'grey', stepUp: [...STEP_UP_METHODS] });
      }

      // A-4.5: adapt only on a confident pass, and at most once per window, so an
      // attacker cannot walk the profile toward themselves.
      if (
        score >= ADAPT_MIN_SCORE &&
        alignment.distance === 0 &&
        now() - profile.updatedAt.getTime() >= ADAPT_WINDOW_MS
      ) {
        // Only an exact script adapts the profile. Folding a fumbled attempt in would
        // teach the profile the fumble.
        const next = adapt(loaded, sample);
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

      await upsertLockout(user.id, 0, null);
      const { accessToken, refreshToken } = await issueSession(
        db,
        config,
        user.id,
        device.id,
        now(),
      );
      return c.json({
        band: 'pass',
        enrolled: true,
        keyVersion: user.keyVersion,
        accessToken,
        refreshToken,
        wrappedVaultKey: user.wrappedVaultKey,
        serverShare: user.serverShare,
      });
    });
  });

  return app;
}
