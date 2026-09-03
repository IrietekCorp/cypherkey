import { Hono } from 'hono';
import type { Db } from './db/client';
import { healthRoutes } from './routes/health';

export type AppDeps = {
  db: Db;
};

/** Builds the HTTP app over injected dependencies, so tests need no listening socket. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.route('/', healthRoutes(deps.db));
  return app;
}
