import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { getFeatureRanges } from '../../../core/biometrics/features';
import type { Profile } from '../../../core/biometrics/score';
import { fromBase64Url } from '../../../core/crypto/encoding';
import { budget } from '../../../core/crypto/phantom';
import type { Strictness } from '../../../core/crypto/phantom';
import { requireAuth, requireReauth } from '../auth/require';
import { scoreAligned } from '../biometrics/score';
import type { Config } from '../config';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';
import { alignCommitments } from '../phantom/align';

/** How many recent scores `GET /user/rhythm` reports (A-10). */
const RECENT_SCORES = 20;
/** X-4 offers 24h and 7d; anything longer is an indefinite pause, not a duration. */
const MAX_PAUSE_MS = 30 * 24 * 60 * 60_000;

/** A base64url string that decodes to exactly `bytes` bytes. */
function b64url(bytes?: number) {
  return z.string().refine((value) => {
    try {
      const decoded = fromBase64Url(value);
      return bytes === undefined ? decoded.length > 0 : decoded.length === bytes;
    } catch {
      return false;
    }
  });
}

/**
 * Everything that changes when Strictness crosses into or out of Strict (A-16).
 *
 * The vault key itself does not change, so the Recovery Kit blob stays valid: it
 * wraps the full `vaultKey` under a key derived from the recovery code, which owes
 * nothing to the passphrase. What changes is `masterKey`, and with it the three
 * branches hanging off it — hence a new authHash, a re-wrapped share, and a fresh
 * commitment sequence.
 */
const rekeySchema = z.object({
  strictness: z.enum(['strict', 'medium', 'relaxed']),
  /**
   * A-17 re-auth. Distinct from `authHash` below: crossing into or out of Strict
   * changes `kdfInput`, so the same passphrase yields a different hash on each side.
   * This is the one the account currently holds, and it is what proves the request.
   */
  currentAuthHash: b64url(32),
  /** The hash the account will hold once the re-key commits. */
  authHash: b64url(32),
  wrappedVaultKey: z.object({ ct: b64url(), nonce: b64url(12) }),
  commitments: z.array(z.string().min(1).max(64)).min(1).max(128),
});

const demoScoreSchema = z.object({
  featureVector: z.array(z.number().finite()).min(1).max(4096),
  commitments: z.array(z.string().min(1).max(64)).min(1).max(128),
});

/** A malformed commitment cannot match anything, so it aligns as a mismatch. */
function decodeCommitment(value: string): Uint8Array {
  try {
    return fromBase64Url(value);
  } catch {
    return new Uint8Array(0);
  }
}

const settingsSchema = z
  .object({
    biometricEnabled: z.boolean().optional(),
    pauseUntil: z.number().int().positive().nullable().optional(),
    thresholds: z.object({ strictness: z.enum(['strict', 'medium', 'relaxed']) }).optional(),
    /** A-17: required for any change that weakens protection. Ignored otherwise. */
    authHash: b64url(32).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'empty patch' });

export type UserDeps = { db: Db; config: Config; now?: () => number };

export function userRoutes(deps: UserDeps): Hono {
  const app = new Hono();
  const { db, config } = deps;
  const now = deps.now ?? Date.now;

  const q = {
    user: async (id: string) =>
      (db.dialect === 'sqlite'
        ? await db.drizzle.select().from(sqliteSchema.users).where(eq(sqliteSchema.users.id, id))
        : await db.drizzle.select().from(pgSchema.users).where(eq(pgSchema.users.id, id)))[0],
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
    recentScores: async (userId: string) =>
      db.dialect === 'sqlite'
        ? await db.drizzle
            .select()
            .from(sqliteSchema.authScoreHistory)
            .where(eq(sqliteSchema.authScoreHistory.userId, userId))
            .orderBy(desc(sqliteSchema.authScoreHistory.createdAt))
            .limit(RECENT_SCORES)
        : await db.drizzle
            .select()
            .from(pgSchema.authScoreHistory)
            .where(eq(pgSchema.authScoreHistory.userId, userId))
            .orderBy(desc(pgSchema.authScoreHistory.createdAt))
            .limit(RECENT_SCORES),
  };

  const settingsOf = (user: {
    biometricEnabled: boolean;
    biometricPausedUntil: Date | null;
    thresholdsJson: { strictness?: 'strict' | 'medium' | 'relaxed' } | null;
    keyVersion: number;
  }) => ({
    biometricEnabled: user.biometricEnabled,
    pauseUntil: user.biometricPausedUntil === null ? null : user.biometricPausedUntil.getTime(),
    // A-16: Medium is the default, and an account with nothing stored is on it.
    thresholds: { strictness: user.thresholdsJson?.strictness ?? 'medium' },
    keyVersion: user.keyVersion,
  });

  app.get('/user/settings', async (c) => {
    const auth = await requireAuth(db, config, c.req, '', now());
    if (auth === null) return c.json({ error: 'unauthorized' }, 401);
    const user = await q.user(auth.userId);
    if (user === undefined) return c.json({ error: 'unauthorized' }, 401);
    return c.json(settingsOf(user));
  });

  app.patch('/user/settings', async (c) => {
    const rawBody = await c.req.text();
    const auth = await requireAuth(db, config, c.req, rawBody, now());
    if (auth === null) return c.json({ error: 'unauthorized' }, 401);

    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = settingsSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const patch = parsed.data;

    // X-4: pausing must require a step-up, or an attacker holding the passphrase
    // simply switches the rhythm off. The same goes for disabling it outright and
    // for A-16's Strictness. Turning protection back *on* is always safe, so
    // biometricEnabled=true and pauseUntil=null need nothing.
    const weakens =
      patch.biometricEnabled === false ||
      (patch.pauseUntil !== undefined && patch.pauseUntil !== null) ||
      patch.thresholds !== undefined;

    if (weakens) {
      // A-17: the passphrase travels in THIS request. A `stepUpAt` claim proved only
      // that a step-up happened in the last five minutes, so anyone holding an unlocked
      // popup inside that window could switch the rhythm off.
      if (patch.authHash === undefined) {
        return c.json({ error: 'passphrase_required' }, 403);
      }
      if ((await requireReauth(db, auth.userId, patch.authHash)) === null) {
        return c.json({ error: 'passphrase_required' }, 403);
      }
    }

    if (patch.pauseUntil != null && patch.pauseUntil - now() > MAX_PAUSE_MS) {
      return c.json({ error: 'pause_too_long' }, 400);
    }

    // A-16: moving to or from Strict changes kdfInput and therefore masterKey, so it
    // is a re-key, not a settings edit. Refused here rather than silently storing a
    // value that would lock the account out; M1-17c owns that flow.
    const user = await q.user(auth.userId);
    if (user === undefined) return c.json({ error: 'unauthorized' }, 401);
    const currentStrictness = user.thresholdsJson?.strictness ?? 'medium';
    if (
      patch.thresholds !== undefined &&
      (patch.thresholds.strictness === 'strict' || currentStrictness === 'strict') &&
      patch.thresholds.strictness !== currentStrictness
    ) {
      return c.json({ error: 'strict_requires_rekey' }, 409);
    }

    const update: Record<string, unknown> = {};
    if (patch.biometricEnabled !== undefined) update.biometricEnabled = patch.biometricEnabled;
    if (patch.pauseUntil !== undefined) {
      update.biometricPausedUntil = patch.pauseUntil === null ? null : new Date(patch.pauseUntil);
    }
    if (patch.thresholds !== undefined) {
      update.thresholdsJson = {
        ...(user.thresholdsJson ?? {}),
        strictness: patch.thresholds.strictness,
      };
    }

    if (db.dialect === 'sqlite') {
      await db.drizzle
        .update(sqliteSchema.users)
        .set(update)
        .where(eq(sqliteSchema.users.id, user.id));
    } else {
      await db.drizzle.update(pgSchema.users).set(update).where(eq(pgSchema.users.id, user.id));
    }

    const updated = await q.user(auth.userId);
    return c.json(settingsOf(updated as NonNullable<typeof updated>));
  });

  app.post('/user/rekey', async (c) => {
    const rawBody = await c.req.text();
    const auth = await requireAuth(db, config, c.req, rawBody, now());
    if (auth === null) return c.json({ error: 'unauthorized' }, 401);

    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = rekeySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const input = parsed.data;

    // A-17: this rotates the master key, so the passphrase travels in this request.
    // `currentAuthHash` rather than `authHash`, which is the value the account will
    // hold *after* the crossing and proves nothing about who is asking.
    if ((await requireReauth(db, auth.userId, input.currentAuthHash)) === null) {
      return c.json({ error: 'passphrase_required' }, 403);
    }

    const user = await q.user(auth.userId);
    if (user === undefined) return c.json({ error: 'unauthorized' }, 401);

    const profile = await q.profile(auth.userId);
    // The script does not change when Strictness does — only the key that commits to
    // it — so a different token count means the client rebuilt the wrong thing.
    if (profile !== undefined && input.commitments.length !== profile.scriptLen) {
      return c.json({ error: 'commitment_length_mismatch' }, 400);
    }

    const authHash = await Bun.password.hash(input.authHash, { algorithm: 'argon2id' });
    const keyVersion = user.keyVersion + 1;
    const update = {
      authHash,
      wrappedVaultKey: input.wrappedVaultKey,
      // A-7: every other device is holding a cache wrapped under the old wrapKey.
      // Bumping this is how they learn to throw it away.
      keyVersion,
      thresholdsJson: { ...(user.thresholdsJson ?? {}), strictness: input.strictness },
    };

    if (db.dialect === 'sqlite') {
      await db.drizzle
        .update(sqliteSchema.users)
        .set(update)
        .where(eq(sqliteSchema.users.id, user.id));
      if (profile !== undefined) {
        await db.drizzle
          .update(sqliteSchema.biometricProfiles)
          .set({ scriptCommitments: input.commitments, updatedAt: new Date(now()) })
          .where(eq(sqliteSchema.biometricProfiles.userId, user.id));
      }
    } else {
      await db.drizzle.update(pgSchema.users).set(update).where(eq(pgSchema.users.id, user.id));
      if (profile !== undefined) {
        await db.drizzle
          .update(pgSchema.biometricProfiles)
          .set({ scriptCommitments: input.commitments, updatedAt: new Date(now()) })
          .where(eq(pgSchema.biometricProfiles.userId, user.id));
      }
    }

    return c.json({ keyVersion, strictness: input.strictness });
  });

  app.get('/user/rhythm', async (c) => {
    const auth = await requireAuth(db, config, c.req, '', now());
    if (auth === null) return c.json({ error: 'unauthorized' }, 401);

    const [profile, history] = await Promise.all([
      q.profile(auth.userId),
      q.recentScores(auth.userId),
    ]);
    // Scalars only. A-4.6 keeps scores and aggregates; nothing here can be inverted
    // into timings, which is what makes this stat shareable (X-7).
    const recentScores = history.map((row) => row.score);

    return c.json({
      sampleCount: profile?.sampleCount ?? 0,
      recentScores,
      consistency: consistencyOf(recentScores),
    });
  });

  /**
   * `POST /user/demo-score` — X-7's party trick, and nothing else.
   *
   * Scoring a friend's attempt through `/auth/login` would be wrong twice over: three
   * refused attempts plus the owner's own would march the account toward a lockout
   * during a demo, and each would leave a row in `auth_score_history` describing
   * someone who is not the account holder.
   *
   * So this scores and returns, and does nothing else: no lockout, no history, no
   * adaptation, no tokens. It needs a live session, which means the owner has already
   * unlocked — someone who could call this could already open the vault, so it grants
   * no reach they did not have.
   */
  app.post('/user/demo-score', async (c) => {
    const rawBody = await c.req.text();
    const auth = await requireAuth(db, config, c.req, rawBody, now());
    if (auth === null) return c.json({ error: 'unauthorized' }, 401);

    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = demoScoreSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const input = parsed.data;

    const [user, profile] = await Promise.all([q.user(auth.userId), q.profile(auth.userId)]);
    if (user === undefined) return c.json({ error: 'unauthorized' }, 401);
    if (profile === undefined) return c.json({ error: 'not_enrolled' }, 409);

    const loginLen = input.commitments.length;
    if (input.featureVector.length !== getFeatureRanges(loginLen).totalLength) {
      return c.json({ error: 'invalid_vector_length' }, 400);
    }

    const level: Strictness = user.thresholdsJson?.strictness ?? 'medium';
    const alignment = alignCommitments(
      profile.scriptCommitments.map(decodeCommitment),
      input.commitments.map(decodeCommitment),
    );
    const allowed = budget(level, profile.scriptLen);
    const phantomsMatched =
      alignment.insertions <= allowed.maxInsertions &&
      alignment.deletions + alignment.substitutions <= allowed.maxMissing;

    const loaded: Profile = {
      version: 1,
      len: profile.scriptLen,
      means: profile.means,
      stds: profile.stds,
      weights: profile.weights,
      sampleCount: profile.sampleCount,
    };
    const score = scoreAligned(
      loaded,
      { version: 1 as const, len: loginLen, values: input.featureVector },
      alignment,
    );

    // The raw score comes back so the client can re-band it at another Strictness
    // without asking again — the lever in X-7 re-judges attempts already recorded.
    return c.json({ score, phantomsMatched, strictness: level });
  });

  return app;
}

/**
 * X-7's "your rhythm is 94% consistent": 1 − the population standard deviation of
 * recent scores. It measures steadiness, not skill, so a user who always scores 0.7
 * is more consistent than one alternating 0.5 and 0.9. Null below two samples,
 * because a single score has no spread to report.
 */
export function consistencyOf(scores: number[]): number | null {
  if (scores.length < 2) return null;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
  return Math.max(0, Math.min(1, 1 - Math.sqrt(variance)));
}
