import { Hono } from 'hono';
import type { Config } from './config';
import type { Db } from './db/client';
import { auditLog } from './middleware/audit';
import { rateLimit } from './middleware/rate-limit';
import { authRoutes } from './routes/auth';
import { enrollRoutes } from './routes/enroll';
import { healthRoutes } from './routes/health';
import { loginRoutes } from './routes/login';
import { sessionRoutes } from './routes/session';
import { stepUpRoutes } from './routes/stepup';
import { userRoutes } from './routes/user';
import { vaultRoutes } from './routes/vault';

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
  if (deps.config !== undefined) {
    // Order matters: the limiter must run before anything expensive, and the audit
    // middleware wraps the response so it can record the status.
    app.use('*', rateLimit({ db: deps.db, config: deps.config, now: deps.now }));
    app.use('*', auditLog({ db: deps.db, config: deps.config, now: deps.now }));
  }
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
    app.route('/', enrollRoutes({ db: deps.db, config: deps.config, now: deps.now }));
    app.route(
      '/',
      loginRoutes({
        db: deps.db,
        config: deps.config,
        timingFloorMs: deps.timingFloorMs ?? DEFAULT_TIMING_FLOOR_MS,
        now: deps.now,
      }),
    );
    app.route('/', sessionRoutes({ db: deps.db, config: deps.config, now: deps.now }));
    app.route('/', vaultRoutes({ db: deps.db, config: deps.config, now: deps.now }));
    app.route('/', userRoutes({ db: deps.db, config: deps.config, now: deps.now }));
    app.route(
      '/',
      stepUpRoutes({
        db: deps.db,
        config: deps.config,
        timingFloorMs: deps.timingFloorMs ?? DEFAULT_TIMING_FLOOR_MS,
        now: deps.now,
      }),
    );
  }
  return app;
}
