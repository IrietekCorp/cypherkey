import { Hono } from 'hono';
import type { Config } from './config';
import type { Db } from './db/client';
import type { Mailer } from './mail/client';
import { auditLog } from './middleware/audit';
import { rateLimit } from './middleware/rate-limit';
import { authRoutes } from './routes/auth';
import { backupCodeRoutes } from './routes/backup-codes';
import { enrollRoutes } from './routes/enroll';
import { healthRoutes } from './routes/health';
import { loginRoutes } from './routes/login';
import { recoverRoutes } from './routes/recover';
import { sessionRoutes } from './routes/session';
import { stepUpRoutes } from './routes/stepup';
import { userRoutes } from './routes/user';
import { vaultRoutes } from './routes/vault';

/** A-5: every auth response is padded to this floor. Tests pass 0. */
const DEFAULT_TIMING_FLOOR_MS = 500;

export type AppDeps = {
  db: Db;
  /**
   * Required, and deliberately so.
   *
   * It used to be optional, and every route except `/healthz` was mounted behind
   * `if (deps.config !== undefined)`. The production entrypoint then called
   * `createApp({ db })` and shipped a server that answered `/healthz` with 200 and
   * everything else with 404 -- a deploy that looked healthy by every check we had,
   * while no client could sign up or log in. Optional dependencies that silently
   * remove most of the application are not a convenience.
   */
  config: Config;
  timingFloorMs?: number;
  /**
   * X-3's failure notice. Absent by default, so a self-hosted instance with no mail
   * provider simply does not send one rather than failing logins it cannot email about.
   */
  mailer?: Mailer;
  now?: () => number;
};

/** Builds the HTTP app over injected dependencies, so tests need no listening socket. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  /*
    `/healthz` is mounted BEFORE the middleware, and Hono matches in registration order,
    so the probe route is exempt from both.

    This is not a convenience. Cloud Run probes `/healthz` on startup and then every 30
    seconds for the life of the instance: running it through `auditLog` would write an
    audit row per probe forever, and through `rateLimit` would spend a real budget on
    liveness checks -- and a throttled health check reads as an unhealthy instance,
    which is how a rate limiter takes down the service it is protecting.
  */
  app.route('/', healthRoutes(deps.db));

  // Order matters: the limiter must run before anything expensive, and the audit
  // middleware wraps the response so it can record the status.
  app.use('*', rateLimit({ db: deps.db, config: deps.config, now: deps.now }));
  app.use('*', auditLog({ db: deps.db, config: deps.config, now: deps.now }));

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
      ...(deps.mailer === undefined ? {} : { mailer: deps.mailer }),
    }),
  );
  app.route(
    '/',
    recoverRoutes({
      db: deps.db,
      config: deps.config,
      timingFloorMs: deps.timingFloorMs ?? DEFAULT_TIMING_FLOOR_MS,
      now: deps.now,
    }),
  );
  app.route('/', sessionRoutes({ db: deps.db, config: deps.config, now: deps.now }));
  app.route('/', vaultRoutes({ db: deps.db, config: deps.config, now: deps.now }));
  app.route('/', userRoutes({ db: deps.db, config: deps.config, now: deps.now }));
  app.route('/', backupCodeRoutes({ db: deps.db, config: deps.config, now: deps.now }));
  app.route(
    '/',
    stepUpRoutes({
      db: deps.db,
      config: deps.config,
      timingFloorMs: deps.timingFloorMs ?? DEFAULT_TIMING_FLOOR_MS,
      now: deps.now,
    }),
  );
  return app;
}
