/**
 * Postgres is never installed locally and is never in our container image — production
 * reaches a managed instance over the network via `DATABASE_URL`. Dev and local `bun test`
 * run on SQLite; the Postgres cases skip cleanly and run in CI against a `postgres:16`
 * service container. See docs/02 A-8 and the M1-15 workflow.
 */
export const postgresUrl = Bun.env.DATABASE_URL?.startsWith('postgres')
  ? Bun.env.DATABASE_URL
  : undefined;

/** True when there is no Postgres to talk to, so Postgres-only suites should skip. */
export const noPostgres = postgresUrl === undefined;

if (noPostgres) {
  console.log('· Postgres suites skipped: DATABASE_URL is not a postgres:// URL (CI sets it).');
}
