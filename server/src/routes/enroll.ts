import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { getFeatureRanges } from '../../../core/biometrics/features';
import { buildProfile } from '../../../core/biometrics/score';
import type { FeatureVector } from '../../../core/biometrics/types';
import { verifyDeviceSignature } from '../auth/signature';
import { bearerToken, verifyToken } from '../auth/token';
import type { Config } from '../config';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';

/**
 * `03` X-2 requires at least 12 resolved characters, and Phantom Keys only ever add
 * tokens, so a script is never shorter than that. Enforced here because enrollment is
 * where the profile shape is fixed: a 1-token "script" is a legal `3n + 5` vector and
 * would produce a profile that scores everything alike.
 */
const MIN_SCRIPT_LEN = 12;

/**
 * A-4.2: the vector is `3n + 5` — n dwell, n−1 flight, n−1 digraph, 7 globals — so a
 * valid length determines `n` exactly. The candidate is confirmed against
 * `getFeatureRanges`, which is the single definition of the layout (AGENTS), rather
 * than trusting the formula written out a second time here.
 */
function scriptLenFor(vectorLength: number): number | null {
  const n = (vectorLength - 5) / 3;
  if (!Number.isInteger(n) || n < MIN_SCRIPT_LEN) return null;
  return getFeatureRanges(n).totalLength === vectorLength ? n : null;
}

const sampleSchema = z.object({
  featureVector: z.array(z.number().finite()).min(1).max(4096),
});

export type EnrollDeps = { db: Db; config: Config; now?: () => number };

export function enrollRoutes(deps: EnrollDeps): Hono {
  const app = new Hono();
  const { db, config } = deps;
  const now = deps.now ?? Date.now;

  /**
   * A-10: enrollment needs a scoped token *and* a device signature. Returns the
   * user id, or null — the caller answers 401 without saying which check failed.
   */
  async function authorize(
    c: {
      req: { url: string; method: string; raw: Request };
    },
    rawBody: string,
  ): Promise<string | null> {
    const token = bearerToken(c.req.raw.headers);
    if (token === null) return null;
    const claims = verifyToken(token, config.jwtSecret, 'enroll', now());
    if (claims === null) return null;

    const url = new URL(c.req.url);
    const verified = await verifyDeviceSignature(
      db,
      {
        method: c.req.method,
        path: url.pathname + url.search,
        rawBody,
        headers: c.req.raw.headers,
      },
      now(),
    );
    // The token names a user and the signature names a device; they must agree.
    if (verified === null || verified.userId !== claims.sub) return null;
    return claims.sub;
  }

  async function loadUser(userId: string) {
    const rows =
      db.dialect === 'sqlite'
        ? await db.drizzle
            .select()
            .from(sqliteSchema.users)
            .where(eq(sqliteSchema.users.id, userId))
        : await db.drizzle.select().from(pgSchema.users).where(eq(pgSchema.users.id, userId));
    return rows[0];
  }

  async function loadProfile(userId: string) {
    const rows =
      db.dialect === 'sqlite'
        ? await db.drizzle
            .select()
            .from(sqliteSchema.biometricProfiles)
            .where(eq(sqliteSchema.biometricProfiles.userId, userId))
        : await db.drizzle
            .select()
            .from(pgSchema.biometricProfiles)
            .where(eq(pgSchema.biometricProfiles.userId, userId));
    return rows[0];
  }

  async function loadSamples(userId: string) {
    return db.dialect === 'sqlite'
      ? await db.drizzle
          .select()
          .from(sqliteSchema.enrollmentSamples)
          .where(eq(sqliteSchema.enrollmentSamples.userId, userId))
      : await db.drizzle
          .select()
          .from(pgSchema.enrollmentSamples)
          .where(eq(pgSchema.enrollmentSamples.userId, userId));
  }

  app.get('/enroll/status', async (c) => {
    const userId = await authorize(c, '');
    if (userId === null) return c.json({ error: 'unauthorized' }, 401);

    const [profile, samples] = await Promise.all([loadProfile(userId), loadSamples(userId)]);
    const required = config.enrollmentSamples;
    return c.json({
      required,
      submitted: samples.length,
      remaining: profile === undefined ? Math.max(0, required - samples.length) : 0,
      built: profile !== undefined,
    });
  });

  app.post('/enroll/sample', async (c) => {
    const rawBody = await c.req.text();
    const userId = await authorize(c, rawBody);
    if (userId === null) return c.json({ error: 'unauthorized' }, 401);

    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = sampleSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const vector = parsed.data.featureVector;

    const scriptLen = scriptLenFor(vector.length);
    if (scriptLen === null) return c.json({ error: 'invalid_vector_length' }, 400);

    const user = await loadUser(userId);
    if (user === undefined) return c.json({ error: 'unauthorized' }, 401);
    // A-5: a user must be able to recover before any biometric gate is built.
    if (user.recoveryWrappedVaultKey === null) {
      return c.json({ error: 'recovery_key_required' }, 409);
    }
    if ((await loadProfile(userId)) !== undefined) {
      return c.json({ error: 'already_enrolled' }, 409);
    }

    const samples = await loadSamples(userId);
    // The first sample fixes the script length; the rest must agree, or the
    // profile would be built from vectors that are not comparable.
    const first = samples[0];
    if (first !== undefined && first.featureVector.length !== vector.length) {
      return c.json({ error: 'script_length_mismatch' }, 400);
    }
    if (samples.length >= config.enrollmentSamples) {
      return c.json({ error: 'enough_samples' }, 409);
    }

    const row = {
      id: crypto.randomUUID(),
      userId,
      featureVector: vector,
      createdAt: new Date(now()),
    };
    if (db.dialect === 'sqlite') {
      await db.drizzle.insert(sqliteSchema.enrollmentSamples).values(row);
    } else {
      await db.drizzle.insert(pgSchema.enrollmentSamples).values(row);
    }

    return c.json({ samplesRemaining: config.enrollmentSamples - (samples.length + 1) });
  });

  app.post('/enroll/build', async (c) => {
    const rawBody = await c.req.text();
    const userId = await authorize(c, rawBody);
    if (userId === null) return c.json({ error: 'unauthorized' }, 401);

    if ((await loadProfile(userId)) !== undefined) {
      return c.json({ error: 'already_enrolled' }, 409);
    }

    const samples = await loadSamples(userId);
    if (samples.length < config.enrollmentSamples) {
      return c.json({ error: 'not_enough_samples' }, 409);
    }

    const scriptLen = scriptLenFor(samples[0]?.featureVector.length ?? 0);
    if (scriptLen === null) return c.json({ error: 'invalid_vector_length' }, 400);

    const vectors: FeatureVector[] = samples.map((s) => ({
      version: 1,
      len: scriptLen,
      values: s.featureVector,
    }));
    const profile = buildProfile(vectors);

    const row = {
      userId,
      scriptLen,
      means: profile.means,
      stds: profile.stds,
      weights: profile.weights,
      // A-14.2 commitments arrive with M1-17b. An empty canonical sequence fails
      // every alignment closed, which is the safe direction until it is populated.
      scriptCommitments: [] as string[],
      sampleCount: profile.sampleCount,
      updatedAt: new Date(now()),
    };

    if (db.dialect === 'sqlite') {
      await db.drizzle.insert(sqliteSchema.biometricProfiles).values(row);
      // A-4.3 and A-4.6: samples exist only to build the profile.
      await db.drizzle
        .delete(sqliteSchema.enrollmentSamples)
        .where(eq(sqliteSchema.enrollmentSamples.userId, userId));
    } else {
      await db.drizzle.insert(pgSchema.biometricProfiles).values(row);
      await db.drizzle
        .delete(pgSchema.enrollmentSamples)
        .where(eq(pgSchema.enrollmentSamples.userId, userId));
    }

    return c.json({ built: true, scriptLen, sampleCount: profile.sampleCount });
  });

  return app;
}
