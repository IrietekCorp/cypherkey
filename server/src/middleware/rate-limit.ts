import { eq, lt } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import type { Config } from '../config';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';
import { clientIp, saltedId } from './identity';

/** A-8 / M1-14: 100 requests a minute from one address. */
export const IP_LIMIT = { capacity: 100, windowMs: 60_000 };
/** A-8 / M1-14: 10 login attempts a minute against one account. */
export const ACCOUNT_LIMIT = { capacity: 10, windowMs: 60_000 };

/** Paths where a per-account bucket applies on top of the per-IP one. */
const ACCOUNT_SCOPED = new Set(['/auth/login', '/auth/step-up']);

export type Bucket = { capacity: number; windowMs: number };

export type RateLimitDeps = { db: Db; config: Config; now?: () => number };

/**
 * Classic token bucket, refilled continuously rather than in steps, so a caller
 * cannot burst the full capacity again the instant a window boundary passes.
 * Returns false when the request must be rejected.
 */
async function take(db: Db, key: string, bucket: Bucket, now: number): Promise<boolean> {
  const rows =
    db.dialect === 'sqlite'
      ? await db.drizzle
          .select()
          .from(sqliteSchema.rateLimits)
          .where(eq(sqliteSchema.rateLimits.key, key))
      : await db.drizzle.select().from(pgSchema.rateLimits).where(eq(pgSchema.rateLimits.key, key));
  const row = rows[0];

  const refillPerMs = bucket.capacity / bucket.windowMs;
  /*
    Elapsed time is clamped at zero, so a clock that appears to run backwards can only
    fail to refill -- it can never *drain* a bucket.

    Without the clamp, `now - updatedAt` goes negative whenever a stored row is dated
    ahead of the current time, and the negative refill is subtracted from the caller's
    tokens: a bucket can be pushed arbitrarily far below zero and stay there. An NTP
    correction, a clock skew between instances sharing one Postgres, or a replayed
    database snapshot is enough to lock a caller out of an endpoint for as long as the
    gap lasts, with no way to tell it from a real throttle.

    It bit the e2e first, which runs on a frozen clock it advances forward and shares
    the `unknown` IP bucket across runs: one run dated the row into the future and the
    next was throttled at its fourth login on a bucket it had never used.
  */
  const elapsedMs = Math.max(0, now - (row?.updatedAt.getTime() ?? now));
  const tokens =
    row === undefined
      ? bucket.capacity
      : Math.min(bucket.capacity, row.tokens + elapsedMs * refillPerMs);

  if (tokens < 1) {
    // Still record the attempt time so the refill maths stays continuous.
    if (db.dialect === 'sqlite') {
      await db.drizzle
        .update(sqliteSchema.rateLimits)
        .set({ tokens, updatedAt: new Date(now) })
        .where(eq(sqliteSchema.rateLimits.key, key));
    } else {
      await db.drizzle
        .update(pgSchema.rateLimits)
        .set({ tokens, updatedAt: new Date(now) })
        .where(eq(pgSchema.rateLimits.key, key));
    }
    return false;
  }

  const next = { key, tokens: tokens - 1, updatedAt: new Date(now) };
  if (row === undefined) {
    if (db.dialect === 'sqlite') await db.drizzle.insert(sqliteSchema.rateLimits).values(next);
    else await db.drizzle.insert(pgSchema.rateLimits).values(next);
  } else if (db.dialect === 'sqlite') {
    await db.drizzle
      .update(sqliteSchema.rateLimits)
      .set({ tokens: next.tokens, updatedAt: next.updatedAt })
      .where(eq(sqliteSchema.rateLimits.key, key));
  } else {
    await db.drizzle
      .update(pgSchema.rateLimits)
      .set({ tokens: next.tokens, updatedAt: next.updatedAt })
      .where(eq(pgSchema.rateLimits.key, key));
  }
  return true;
}

/** Drops buckets that have been full and idle long enough to be indistinguishable from absent. */
async function prune(db: Db, now: number): Promise<void> {
  const cutoff = new Date(now - 10 * 60_000);
  if (db.dialect === 'sqlite') {
    await db.drizzle
      .delete(sqliteSchema.rateLimits)
      .where(lt(sqliteSchema.rateLimits.updatedAt, cutoff));
  } else {
    await db.drizzle.delete(pgSchema.rateLimits).where(lt(pgSchema.rateLimits.updatedAt, cutoff));
  }
}

/** How often to sweep idle buckets. A counter, not a random draw: AGENTS §5 keeps
 *  randomness out of security paths, and a deterministic cadence is testable. */
const PRUNE_EVERY = 256;

export function rateLimit(deps: RateLimitDeps): MiddlewareHandler {
  const { db, config } = deps;
  const now = deps.now ?? Date.now;
  let seen = 0;

  return async (c, next) => {
    const at = now();
    const path = new URL(c.req.url).pathname;

    const ipKey = saltedId(config.jwtSecret, 'ratelimit/ip', clientIp(c.req.raw.headers));
    if (!(await take(db, ipKey, IP_LIMIT, at))) {
      return c.json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
    }

    if (c.req.method === 'POST' && ACCOUNT_SCOPED.has(path)) {
      // The username comes from the body; Hono caches it, so the route can read it again.
      let username: string | undefined;
      try {
        const parsed = JSON.parse(await c.req.text()) as { username?: unknown };
        if (typeof parsed.username === 'string') username = parsed.username;
      } catch {
        username = undefined;
      }
      if (username !== undefined) {
        // A bucket exists whether or not the account does, so 429 is not an oracle.
        const accountKey = saltedId(config.jwtSecret, 'ratelimit/account', username);
        if (!(await take(db, accountKey, ACCOUNT_LIMIT, at))) {
          return c.json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
        }
      }
    }

    seen++;
    if (seen % PRUNE_EVERY === 0) await prune(db, at);
    await next();
  };
}
