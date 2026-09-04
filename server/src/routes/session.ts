import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../auth/require';
import { hashRefreshToken, issueSession } from '../auth/session-tokens';
import { verifyDeviceSignature } from '../auth/signature';
import type { Config } from '../config';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';

/** Guards the chain walk in `revokeFamily` against a cycle in bad data. */
const MAX_FAMILY_DEPTH = 256;

const refreshSchema = z.object({ refreshToken: z.string().min(1).max(512) });

export type SessionDeps = { db: Db; config: Config; now?: () => number };

export function sessionRoutes(deps: SessionDeps): Hono {
  const app = new Hono();
  const { db, config } = deps;
  const now = deps.now ?? Date.now;

  const q = {
    tokenByHash: async (tokenHash: string) =>
      (db.dialect === 'sqlite'
        ? await db.drizzle
            .select()
            .from(sqliteSchema.refreshTokens)
            .where(eq(sqliteSchema.refreshTokens.tokenHash, tokenHash))
        : await db.drizzle
            .select()
            .from(pgSchema.refreshTokens)
            .where(eq(pgSchema.refreshTokens.tokenHash, tokenHash)))[0],
    tokenById: async (id: string) =>
      (db.dialect === 'sqlite'
        ? await db.drizzle
            .select()
            .from(sqliteSchema.refreshTokens)
            .where(eq(sqliteSchema.refreshTokens.id, id))
        : await db.drizzle
            .select()
            .from(pgSchema.refreshTokens)
            .where(eq(pgSchema.refreshTokens.id, id)))[0],
    devicesOf: async (userId: string) =>
      db.dialect === 'sqlite'
        ? await db.drizzle
            .select()
            .from(sqliteSchema.devices)
            .where(eq(sqliteSchema.devices.userId, userId))
        : await db.drizzle
            .select()
            .from(pgSchema.devices)
            .where(eq(pgSchema.devices.userId, userId)),
    deviceById: async (id: string) =>
      (db.dialect === 'sqlite'
        ? await db.drizzle
            .select()
            .from(sqliteSchema.devices)
            .where(eq(sqliteSchema.devices.id, id))
        : await db.drizzle.select().from(pgSchema.devices).where(eq(pgSchema.devices.id, id)))[0],
  };

  async function revokeToken(id: string, replacedBy?: string): Promise<void> {
    const set = { revokedAt: new Date(now()), ...(replacedBy === undefined ? {} : { replacedBy }) };
    if (db.dialect === 'sqlite') {
      await db.drizzle
        .update(sqliteSchema.refreshTokens)
        .set(set)
        .where(eq(sqliteSchema.refreshTokens.id, id));
    } else {
      await db.drizzle
        .update(pgSchema.refreshTokens)
        .set(set)
        .where(eq(pgSchema.refreshTokens.id, id));
    }
  }

  /**
   * Revokes a rotation chain from `startId` forward. Presenting an already-rotated
   * token means either the holder replayed it or someone stole it; the two cannot be
   * told apart, so every descendant dies — including the one the honest user holds.
   * That is the intended cost: a stolen chain is cut, and the user logs in again.
   */
  async function revokeFamily(startId: string): Promise<void> {
    let id: string | null = startId;
    for (let depth = 0; id !== null && depth < MAX_FAMILY_DEPTH; depth++) {
      const row = await q.tokenById(id);
      if (row === undefined) return;
      await revokeToken(row.id);
      id = row.replacedBy;
    }
  }

  async function revokeAllForDevice(userId: string, deviceId: string): Promise<void> {
    const set = { revokedAt: new Date(now()) };
    if (db.dialect === 'sqlite') {
      await db.drizzle
        .update(sqliteSchema.refreshTokens)
        .set(set)
        .where(
          and(
            eq(sqliteSchema.refreshTokens.userId, userId),
            eq(sqliteSchema.refreshTokens.deviceId, deviceId),
            isNull(sqliteSchema.refreshTokens.revokedAt),
          ),
        );
    } else {
      await db.drizzle
        .update(pgSchema.refreshTokens)
        .set(set)
        .where(
          and(
            eq(pgSchema.refreshTokens.userId, userId),
            eq(pgSchema.refreshTokens.deviceId, deviceId),
            isNull(pgSchema.refreshTokens.revokedAt),
          ),
        );
    }
  }

  /**
   * A-10 exempts nothing, but refresh cannot require an access token: the access
   * token is precisely what has expired by the time this is called. It is
   * authenticated by the refresh token itself plus the A-3 device signature.
   */
  app.post('/auth/refresh', async (c) => {
    const rawBody = await c.req.text();
    const url = new URL(c.req.url);
    const verified = await verifyDeviceSignature(
      db,
      { method: 'POST', path: url.pathname + url.search, rawBody, headers: c.req.raw.headers },
      now(),
    );
    if (verified === null) return c.json({ error: 'unauthorized' }, 401);

    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = refreshSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

    const row = await q.tokenByHash(hashRefreshToken(parsed.data.refreshToken));
    // Unknown token: nothing to revoke, and nothing to learn from the answer.
    if (row === undefined || row.userId !== verified.userId || row.deviceId !== verified.deviceId) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    if (row.replacedBy !== null) {
      await revokeFamily(row.id);
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (row.revokedAt !== null || row.expiresAt.getTime() <= now()) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const issued = await issueSession(db, config, row.userId, row.deviceId, now());
    await revokeToken(row.id, issued.refreshTokenId);
    return c.json({ accessToken: issued.accessToken, refreshToken: issued.refreshToken });
  });

  app.post('/auth/logout', async (c) => {
    const rawBody = await c.req.text();
    const auth = await requireAuth(db, config, c.req, rawBody, now());
    if (auth === null) return c.json({ error: 'unauthorized' }, 401);

    await revokeAllForDevice(auth.userId, auth.deviceId);
    return c.json({ ok: true });
  });

  app.get('/user/devices', async (c) => {
    const auth = await requireAuth(db, config, c.req, '', now());
    if (auth === null) return c.json({ error: 'unauthorized' }, 401);

    const devices = await q.devicesOf(auth.userId);
    return c.json({
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        trustedAt: d.trustedAt,
        lastSeenAt: d.lastSeenAt,
        revokedAt: d.revokedAt,
        current: d.id === auth.deviceId,
      })),
    });
  });

  app.delete('/user/devices/:id', async (c) => {
    const auth = await requireAuth(db, config, c.req, '', now());
    if (auth === null) return c.json({ error: 'unauthorized' }, 401);

    const id = c.req.param('id');
    const device = await q.deviceById(id);
    // Someone else's device is reported as absent, not as forbidden — otherwise the
    // response tells an attacker which device ids exist.
    if (device === undefined || device.userId !== auth.userId) {
      return c.json({ error: 'not_found' }, 404);
    }

    const revokedAt = new Date(now());
    if (db.dialect === 'sqlite') {
      await db.drizzle
        .update(sqliteSchema.devices)
        .set({ revokedAt })
        .where(eq(sqliteSchema.devices.id, id));
    } else {
      await db.drizzle
        .update(pgSchema.devices)
        .set({ revokedAt })
        .where(eq(pgSchema.devices.id, id));
    }
    await revokeAllForDevice(auth.userId, id);
    return c.json({ ok: true });
  });

  return app;
}
