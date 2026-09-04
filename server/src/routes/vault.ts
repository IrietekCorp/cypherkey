import { and, eq, gt } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../auth/require';
import type { Config } from '../config';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';

/** A-15: a 2,000-item vault is under 2 MB, so these are generous, not tight. */
const MAX_BATCH = 500;
const MAX_CIPHERTEXT_CHARS = 128 * 1024;

const itemSchema = z.object({
  id: z.string().min(1).max(128),
  version: z.number().int().min(0),
  ciphertext: z.string().min(1).max(MAX_CIPHERTEXT_CHARS),
  nonce: z.string().min(1).max(64),
  updatedAt: z.number().int().positive(),
  deletedAt: z.number().int().positive().nullable().optional(),
});

const batchSchema = z.object({ items: z.array(itemSchema).min(1).max(MAX_BATCH) });

export type VaultDeps = { db: Db; config: Config; now?: () => number };

export function vaultRoutes(deps: VaultDeps): Hono {
  const app = new Hono();
  const { db, config } = deps;
  const now = deps.now ?? Date.now;

  const q = {
    itemsSince: async (userId: string, since: number) =>
      db.dialect === 'sqlite'
        ? await db.drizzle
            .select()
            .from(sqliteSchema.vaultItems)
            .where(
              and(
                eq(sqliteSchema.vaultItems.userId, userId),
                gt(sqliteSchema.vaultItems.cursor, since),
              ),
            )
            .orderBy(sqliteSchema.vaultItems.cursor)
        : await db.drizzle
            .select()
            .from(pgSchema.vaultItems)
            .where(
              and(eq(pgSchema.vaultItems.userId, userId), gt(pgSchema.vaultItems.cursor, since)),
            )
            .orderBy(pgSchema.vaultItems.cursor),
    item: async (userId: string, id: string) =>
      (db.dialect === 'sqlite'
        ? await db.drizzle
            .select()
            .from(sqliteSchema.vaultItems)
            .where(
              and(eq(sqliteSchema.vaultItems.userId, userId), eq(sqliteSchema.vaultItems.id, id)),
            )
        : await db.drizzle
            .select()
            .from(pgSchema.vaultItems)
            .where(and(eq(pgSchema.vaultItems.userId, userId), eq(pgSchema.vaultItems.id, id))))[0],
    cursor: async (userId: string) =>
      (db.dialect === 'sqlite'
        ? await db.drizzle
            .select()
            .from(sqliteSchema.vaultCursors)
            .where(eq(sqliteSchema.vaultCursors.userId, userId))
        : await db.drizzle
            .select()
            .from(pgSchema.vaultCursors)
            .where(eq(pgSchema.vaultCursors.userId, userId)))[0],
  };

  /** Advances the user's monotonic counter by `count` and returns the first new value. */
  async function reserveCursors(userId: string, count: number): Promise<number> {
    const existing = await q.cursor(userId);
    const start = (existing?.cursor ?? 0) + 1;
    const next = start + count - 1;
    if (db.dialect === 'sqlite') {
      if (existing === undefined)
        await db.drizzle.insert(sqliteSchema.vaultCursors).values({ userId, cursor: next });
      else
        await db.drizzle
          .update(sqliteSchema.vaultCursors)
          .set({ cursor: next })
          .where(eq(sqliteSchema.vaultCursors.userId, userId));
    } else {
      if (existing === undefined)
        await db.drizzle.insert(pgSchema.vaultCursors).values({ userId, cursor: next });
      else
        await db.drizzle
          .update(pgSchema.vaultCursors)
          .set({ cursor: next })
          .where(eq(pgSchema.vaultCursors.userId, userId));
    }
    return start;
  }

  /** The item shape sent to clients. Ciphertext and nonce are returned exactly as stored. */
  const wire = (row: {
    id: string;
    cursor: number;
    version: number;
    ciphertext: string;
    nonce: string;
    updatedAt: Date;
    deletedAt: Date | null;
  }) => ({
    id: row.id,
    cursor: row.cursor,
    version: row.version,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    updatedAt: row.updatedAt.getTime(),
    deletedAt: row.deletedAt === null ? null : row.deletedAt.getTime(),
  });

  app.get('/vault/changes', async (c) => {
    const auth = await requireAuth(db, config, c.req, '', now());
    if (auth === null) return c.json({ error: 'unauthorized' }, 401);

    const raw = c.req.query('since');
    if (raw === undefined) return c.json({ error: 'since_required' }, 400);
    const since = Number(raw);
    if (!Number.isInteger(since) || since < 0) return c.json({ error: 'invalid_since' }, 400);

    const rows = await q.itemsSince(auth.userId, since);
    const head = (await q.cursor(auth.userId))?.cursor ?? 0;
    return c.json({ items: rows.map(wire), cursor: head });
  });

  app.post('/vault/changes', async (c) => {
    const rawBody = await c.req.text();
    const auth = await requireAuth(db, config, c.req, rawBody, now());
    if (auth === null) return c.json({ error: 'unauthorized' }, 401);

    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = batchSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const items = parsed.data.items;

    // Optimistic concurrency: each item carries the version the client believes the
    // server holds. The server never merges — it cannot read either side — so a
    // mismatch comes back with the server copy and the client resolves it (A-6).
    const existing = new Map<string, Awaited<ReturnType<typeof q.item>>>();
    for (const sent of items) {
      existing.set(sent.id, await q.item(auth.userId, sent.id));
    }

    const conflicts: Array<{ id: string; server: ReturnType<typeof wire> | null }> = [];
    const writable: typeof items = [];
    for (const sent of items) {
      const row = existing.get(sent.id);
      const currentVersion = row?.version ?? 0;
      if (sent.version !== currentVersion) {
        conflicts.push({ id: sent.id, server: row === undefined ? null : wire(row) });
      } else {
        writable.push(sent);
      }
    }

    const applied: Array<{ id: string; version: number; cursor: number }> = [];
    if (writable.length > 0) {
      let cursor = await reserveCursors(auth.userId, writable.length);
      for (const sent of writable) {
        const row = {
          id: sent.id,
          userId: auth.userId,
          cursor,
          version: sent.version + 1,
          ciphertext: sent.ciphertext,
          nonce: sent.nonce,
          updatedAt: new Date(sent.updatedAt),
          deletedAt: sent.deletedAt == null ? null : new Date(sent.deletedAt),
        };
        if (existing.get(sent.id) === undefined) {
          if (db.dialect === 'sqlite') await db.drizzle.insert(sqliteSchema.vaultItems).values(row);
          else await db.drizzle.insert(pgSchema.vaultItems).values(row);
        } else {
          const { id: _id, userId: _userId, ...set } = row;
          if (db.dialect === 'sqlite') {
            await db.drizzle
              .update(sqliteSchema.vaultItems)
              .set(set)
              .where(
                and(
                  eq(sqliteSchema.vaultItems.userId, auth.userId),
                  eq(sqliteSchema.vaultItems.id, sent.id),
                ),
              );
          } else {
            await db.drizzle
              .update(pgSchema.vaultItems)
              .set(set)
              .where(
                and(
                  eq(pgSchema.vaultItems.userId, auth.userId),
                  eq(pgSchema.vaultItems.id, sent.id),
                ),
              );
          }
        }
        applied.push({ id: sent.id, version: row.version, cursor });
        cursor++;
      }
    }

    const head = (await q.cursor(auth.userId))?.cursor ?? 0;
    // Clean items in a mixed batch are applied rather than held hostage by a stale
    // sibling; the 409 says which ones did not land.
    return c.json({ cursor: head, applied, conflicts }, conflicts.length > 0 ? 409 : 200);
  });

  return app;
}
