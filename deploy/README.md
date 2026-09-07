# deploy/ — the hosted stack (M2-16)

Everything CypherKey runs on in production, as files rather than console state. The
console work that had to happen once, by hand, is recorded in `gcp.md` at the repo root.

| | |
|---|---|
| Project | `<GCP_PROJECT_ID>` (number `<GCP_PROJECT_NUMBER>`) |
| Region | `us-central1` |
| API | Cloud Run service `cypherkey-api` → `api.cypherkey.io` |
| Database | Cloud SQL Postgres 16, `<GCP_SQL_CONNECTION>` |
| Images | `us-central1-docker.pkg.dev/<GCP_PROJECT_ID>/cypherkey/server` |
| Secrets | Secret Manager: `JWT_SECRET`, `PGPASSWORD`, `POSTGRES_ROOT_PASSWORD` |
| DNS | Cloud DNS zone `cypherkey-io`, LB IP `<LB_IP>` |

## Files

- **`service.yaml`** — the Cloud Run service. Source of truth; a console edit is reverted
  by the next deploy. Only the image tag is substituted at deploy time.
- **`../.github/workflows/deploy.yml`** — build → migrate → e2e → deploy → smoke test, on
  every push to `main`.

## How a deploy authenticates

Workload Identity Federation, not a service-account key. GitHub mints an OIDC token, the
pool exchanges it for short-lived credentials for `cypherkey-deploy`, and the provider's
attribute condition restricts that exchange to this repository. There is no long-lived
credential anywhere in the repo or in GitHub secrets.

Two service accounts, deliberately separate:

- **`cypherkey-run`** is what the service *runs as*: `roles/cloudsql.client`, plus
  `secretAccessor` on `JWT_SECRET` and `PGPASSWORD` **individually**, and nothing else.
- **`cypherkey-deploy`** is what CI *deploys as*: `run.admin`, `artifactregistry.writer`,
  `cloudsql.client` (it runs the proxy to migrate), `secretAccessor` on `PGPASSWORD`
  only, and `serviceAccountUser` scoped to `cypherkey-run` alone. It cannot read
  `JWT_SECRET`.

## The database connection, and why it looks odd

The service does **not** get a normal `DATABASE_URL`. It gets:

```
DATABASE_URL=postgres:///cypherkey
PGHOST=/cloudsql/<GCP_SQL_CONNECTION>
PGUSER=cypherkey_app
PGPASSWORD=<from Secret Manager>
```

The obvious form — `postgres://user:pw@localhost/cypherkey?host=/cloudsql/...`, which is
what most Cloud Run guides show — **does not work with postgres.js** and fails silently in
the worst way: it connects to TCP `localhost:5432`, finds nothing, and the error looks
like a database outage rather than a configuration mistake.

Two reasons, both verified against `node_modules/postgres/src/index.js`:

1. `parseOptions()` resolves the host as
   `o.hostname || o.host || multihost || url.hostname || env.PGHOST || 'localhost'`.
   A `?host=` query parameter is never consulted; it is forwarded to the server as a
   startup parameter instead.
2. The host is then split on `:` to support `host:port`. A Cloud SQL connection name
   contains two colons, so even a host that did arrive would be truncated to
   `/cloudsql/<GCP_PROJECT_ID>`.

`PGHOST` avoids both: it reaches `host` directly with slashes and colons intact, and
because it contains a `/`, postgres.js derives `path` from it and
`connection.js:350` (`if (options.path) return socket.connect(options.path)`) dials the
unix socket, ignoring the host entirely.

**CI is different on purpose.** The migration and e2e steps reach Cloud SQL through the
Auth proxy's TCP listener, where an ordinary `postgres://user:pw@127.0.0.1:5432/db` URL
is correct. The PG* indirection exists only for the socket.

## Running a deploy

Push to `main`, or trigger **Deploy** manually from the Actions tab. The workflow refuses
to roll forward unless migrations applied, the e2e passed against Cloud SQL, the image is
within the A-15 budget, and the new revision answers `/healthz`.

`/healthz` returns 503 when the database will not answer, so the startup probe gating the
rollout also proves the Cloud SQL socket works — a broken connection string fails the
deploy instead of a user's first login.

## What is deliberately not automated

- **The nameserver cutover.** Registrar-level, one-time, and it takes the domain down if
  it is wrong.
- **Secret rotation.** `JWT_SECRET` rotation invalidates every live session, so it is a
  decision rather than a job.
- **Cloud SQL schema drift.** Migrations only ever run forward, from the repo, in the
  deploy workflow. There is no automatic rollback: a bad migration is fixed by a new one.
