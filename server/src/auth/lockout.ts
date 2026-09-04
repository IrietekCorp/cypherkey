import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';

/** X-3: five failures lock the account. */
export const LOCKOUT_THRESHOLD = 5;
/** The first lock is fifteen minutes; each further one doubles it. */
export const LOCKOUT_BASE_MS = 15 * 60_000;

/**
 * Shared by `/auth/login` and `/auth/step-up`.
 *
 * It lives here rather than inside a route because both doors must count against the
 * same budget. A step-up that did not count was exactly the hole M2-00e closed: an
 * attacker with a stolen passphrase could sit on the step-up endpoint guessing Backup
 * Codes, bounded only by the ten-a-minute rate limit.
 */
export async function readLockout(db: Db, userId: string) {
  return db.dialect === 'sqlite'
    ? (
        await db.drizzle
          .select()
          .from(sqliteSchema.lockouts)
          .where(eq(sqliteSchema.lockouts.userId, userId))
          .limit(1)
      )[0]
    : (
        await db.drizzle
          .select()
          .from(pgSchema.lockouts)
          .where(eq(pgSchema.lockouts.userId, userId))
          .limit(1)
      )[0];
}

async function upsertLockout(
  db: Db,
  userId: string,
  failedCount: number,
  lockedUntil: Date | null,
): Promise<void> {
  const existing = await readLockout(db, userId);
  const row = { userId, failedCount, lockedUntil };
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

/** Counts a failure and locks for 15 minutes, doubling on each further lock. */
export async function recordFailure(db: Db, userId: string, now: number): Promise<void> {
  const existing = await readLockout(db, userId);
  const failedCount = (existing?.failedCount ?? 0) + 1;
  const locks = Math.floor(failedCount / LOCKOUT_THRESHOLD);
  const lockedUntil =
    failedCount >= LOCKOUT_THRESHOLD && failedCount % LOCKOUT_THRESHOLD === 0
      ? new Date(now + LOCKOUT_BASE_MS * 2 ** (locks - 1))
      : (existing?.lockedUntil ?? null);
  await upsertLockout(db, userId, failedCount, lockedUntil);
}

/** A cleared door resets the budget, whichever door it was. */
export async function clearLockout(db: Db, userId: string): Promise<void> {
  const reset = { failedCount: 0, lockedUntil: null };
  if (db.dialect === 'sqlite') {
    await db.drizzle
      .update(sqliteSchema.lockouts)
      .set(reset)
      .where(eq(sqliteSchema.lockouts.userId, userId));
  } else {
    await db.drizzle
      .update(pgSchema.lockouts)
      .set(reset)
      .where(eq(pgSchema.lockouts.userId, userId));
  }
}
