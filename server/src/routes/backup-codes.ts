import { sha256 } from '@noble/hashes/sha2';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { toBase64Url, utf8Encode } from '../../../core/crypto/encoding';
import { randomBytes } from '../../../core/crypto/kdf';
import { requireAuth } from '../auth/require';
import type { Config } from '../config';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';

/** X-3: ten codes per set, replaced as a whole. */
export const BACKUP_CODE_COUNT = 10;
/** Ten Crockford symbols is 50 bits — far beyond guessing, still readable off paper. */
const SYMBOLS_PER_CODE = 10;
const GROUP = 5;

/** Crockford base32: no I, L, O or U, so nothing is confusable when read aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Canonical form for comparison: upper case, no separators, and Crockford's aliases
 * resolved. Someone reading a printed code will type O for 0 and I or L for 1, and
 * that should not cost them a code.
 */
export function normalizeBackupCode(raw: string): string {
  let out = '';
  for (const ch of raw.toUpperCase()) {
    if (ch === 'O') out += '0';
    else if (ch === 'I' || ch === 'L') out += '1';
    else if (ALPHABET.includes(ch)) out += ch;
    // Everything else — hyphens, spaces, stray punctuation — is formatting.
  }
  return out;
}

/**
 * `base64url(sha256(normalized))`, the same treatment as a refresh token and for the
 * same reason: this is a high-entropy secret the *server* generated, so a fast hash is
 * correct. Argon2id exists for low-entropy human input, which this is not.
 */
export function hashBackupCode(raw: string): string {
  return toBase64Url(sha256(utf8Encode(normalizeBackupCode(raw))));
}

/** One code, formatted `XXXXX-XXXXX`. */
function generateBackupCode(): string {
  // Rejection-free because 32 divides 256 evenly, so every byte maps without bias.
  const bytes = randomBytes(SYMBOLS_PER_CODE);
  let symbols = '';
  for (const byte of bytes) symbols += ALPHABET[byte % ALPHABET.length];
  return `${symbols.slice(0, GROUP)}-${symbols.slice(GROUP)}`;
}

/** A full set. Distinctness is enforced here so `code_hash`'s unique index never trips. */
export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateBackupCode());
  return [...codes];
}

/**
 * Replaces the whole set: X-3 says regeneration invalidates every previous code, so
 * this deletes rather than marking used. Returns the plaintext codes, which are shown
 * once and never recoverable afterwards.
 */
export async function replaceBackupCodes(db: Db, userId: string, now: number): Promise<string[]> {
  const codes = generateBackupCodes();
  const rows = codes.map((code) => ({
    id: crypto.randomUUID(),
    userId,
    codeHash: hashBackupCode(code),
    usedAt: null,
    createdAt: new Date(now),
  }));

  if (db.dialect === 'sqlite') {
    await db.drizzle
      .delete(sqliteSchema.backupCodes)
      .where(eq(sqliteSchema.backupCodes.userId, userId));
    await db.drizzle.insert(sqliteSchema.backupCodes).values(rows);
  } else {
    await db.drizzle.delete(pgSchema.backupCodes).where(eq(pgSchema.backupCodes.userId, userId));
    await db.drizzle.insert(pgSchema.backupCodes).values(rows);
  }
  return codes;
}

/**
 * Spends one code if it is this user's, and unused. Returns whether it was accepted.
 *
 * The lookup is scoped to `userId` as well as the hash, so a code that is valid for
 * some other account cannot clear a step-up here.
 */
export async function consumeBackupCode(
  db: Db,
  userId: string,
  proof: string,
  now: number,
): Promise<boolean> {
  const codeHash = hashBackupCode(proof);
  if (codeHash.length === 0) return false;

  if (db.dialect === 'sqlite') {
    const row = (
      await db.drizzle
        .select()
        .from(sqliteSchema.backupCodes)
        .where(
          and(
            eq(sqliteSchema.backupCodes.userId, userId),
            eq(sqliteSchema.backupCodes.codeHash, codeHash),
            isNull(sqliteSchema.backupCodes.usedAt),
          ),
        )
        .limit(1)
    )[0];
    if (row === undefined) return false;
    // Spend it by id, and only while still unused, so a replay cannot spend it twice.
    await db.drizzle
      .update(sqliteSchema.backupCodes)
      .set({ usedAt: new Date(now) })
      .where(and(eq(sqliteSchema.backupCodes.id, row.id), isNull(sqliteSchema.backupCodes.usedAt)));
    return true;
  }

  const row = (
    await db.drizzle
      .select()
      .from(pgSchema.backupCodes)
      .where(
        and(
          eq(pgSchema.backupCodes.userId, userId),
          eq(pgSchema.backupCodes.codeHash, codeHash),
          isNull(pgSchema.backupCodes.usedAt),
        ),
      )
      .limit(1)
  )[0];
  if (row === undefined) return false;
  await db.drizzle
    .update(pgSchema.backupCodes)
    .set({ usedAt: new Date(now) })
    .where(and(eq(pgSchema.backupCodes.id, row.id), isNull(pgSchema.backupCodes.usedAt)));
  return true;
}

/** How many codes are still spendable. */
export async function remainingBackupCodes(db: Db, userId: string): Promise<number> {
  const rows =
    db.dialect === 'sqlite'
      ? await db.drizzle
          .select()
          .from(sqliteSchema.backupCodes)
          .where(
            and(
              eq(sqliteSchema.backupCodes.userId, userId),
              isNull(sqliteSchema.backupCodes.usedAt),
            ),
          )
      : await db.drizzle
          .select()
          .from(pgSchema.backupCodes)
          .where(and(eq(pgSchema.backupCodes.userId, userId), isNull(pgSchema.backupCodes.usedAt)));
  return rows.length;
}

const regenerateSchema = z.object({ authHash: z.string().min(1).max(512) });

export type BackupCodeDeps = { db: Db; config: Config; now?: () => number };

/**
 * `/user/backup-codes` — X-3's fallback factor.
 *
 * A Backup Code opens a **session**; the Recovery Kit opens a **vault**. They are
 * different objects with different failure modes and are never called by the same name.
 */
export function backupCodeRoutes(deps: BackupCodeDeps): Hono {
  const app = new Hono();
  const { db, config } = deps;
  const now = deps.now ?? Date.now;

  const userById = async (userId: string) =>
    db.dialect === 'sqlite'
      ? (
          await db.drizzle
            .select()
            .from(sqliteSchema.users)
            .where(eq(sqliteSchema.users.id, userId))
            .limit(1)
        )[0]
      : (
          await db.drizzle
            .select()
            .from(pgSchema.users)
            .where(eq(pgSchema.users.id, userId))
            .limit(1)
        )[0];

  app.get('/user/backup-codes', async (c) => {
    const auth = await requireAuth(db, config, c.req, '', now());
    if (auth === null) return c.json({ error: 'unauthorized' }, 401);
    // A count, never the codes: they exist in the clear exactly once, at issue.
    return c.json({ remaining: await remainingBackupCodes(db, auth.userId) });
  });

  app.post('/user/backup-codes', async (c) => {
    const rawBody = await c.req.text();
    const auth = await requireAuth(db, config, c.req, rawBody, now());
    if (auth === null) return c.json({ error: 'unauthorized' }, 401);

    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = regenerateSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

    // A-17: a settings change of this weight needs the passphrase presented *in this
    // request*, not a step-up flag minted at some earlier point in the session.
    const user = await userById(auth.userId);
    if (user === undefined) return c.json({ error: 'unauthorized' }, 401);
    if (!(await Bun.password.verify(parsed.data.authHash, user.authHash))) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    return c.json({ backupCodes: await replaceBackupCodes(db, auth.userId, now()) });
  });

  return app;
}
