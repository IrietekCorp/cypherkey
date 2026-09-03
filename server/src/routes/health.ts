import { Hono } from 'hono';
import type { Db } from '../db/client';

/** `GET /healthz` — 200 with the live driver name, 503 if the database will not answer. */
export function healthRoutes(db: Db): Hono {
  const app = new Hono();

  app.get('/healthz', async (c) => {
    try {
      await db.ping();
    } catch {
      // The driver's message can name a user or a host; it never reaches the client.
      return c.json({ ok: false, db: db.dialect }, 503);
    }
    return c.json({ ok: true, db: db.dialect }, 200);
  });

  return app;
}
