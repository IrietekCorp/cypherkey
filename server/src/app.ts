import { Hono } from 'hono';
import type { Config } from './config';
import type { Db } from './db/client';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';

/** A-5: every auth response is padded to this floor. Tests pass 0. */
const DEFAULT_TIMING_FLOOR_MS = 500;

export type AppDeps = {
  db: Db;
  config?: Config;
  timingFloorMs?: number;
  now?: () => number;
};

/** Builds the HTTP app over injected dependencies, so tests need no listening socket. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.route('/', healthRoutes(deps.db));
  if (deps.config !== undefined) {
    app.route(
      '/',
      authRoutes({
        db: deps.db,
        config: deps.config,
        timingFloorMs: deps.timingFloorMs ?? DEFAULT_TIMING_FLOOR_MS,
        now: deps.now,
      }),
    );
  }
  return app;
}
