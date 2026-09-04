import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../auth/require';
import { bearerToken, hasFreshStepUp, verifyToken } from '../auth/token';
import type { Config } from '../config';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';

/** How many recent scores `GET /user/rhythm` reports (A-10). */
const RECENT_SCORES = 20;
/** X-4 offers 24h and 7d; anything longer is an indefinite pause, not a duration. */
const MAX_PAUSE_MS = 30 * 24 * 60 * 60_000;

const settingsSchema = z
  .object({
    biometricEnabled: z.boolean().optional(),
    pauseUntil: z.number().int().positive().nullable().optional(),
    thresholds: z.object({ strictness: z.enum(['strict', 'medium', 'relaxed']) }).optional(),
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
      const token = bearerToken(c.req.raw.headers);
      const claims = token === null ? null : verifyToken(token, config.jwtSecret, 'access', now());
      if (claims === null || !hasFreshStepUp(claims, now())) {
        return c.json({ error: 'step_up_required' }, 403);
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
