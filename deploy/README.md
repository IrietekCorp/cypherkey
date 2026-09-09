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

## The static site, and the headers that nearly went missing

`cypherkey.io` and `www` are a Cloud Storage bucket (`<GCP_SITE_BUCKET>`) behind a
CDN-enabled backend bucket; `api.cypherkey.io` is the Cloud Run service. One load
balancer, one IP, one certificate covering all three names.

The site used to be Cloudflare Pages, and it carried two files that looked like dead
config after the move — `site/public/_headers` and `site/public/_redirects`. They were
not dead. Between them they set the site's **entire** security header policy (CSP, HSTS,
`X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`) and both redirects (www→apex,
http→https). **Cloud Storage ignores both files completely**, so publishing the same
`dist/` to a bucket serves a site with no CSP and no HSTS, and nothing warns you.

Their behaviour now lives in the load balancer, which is why the files are gone from the
repo rather than uploaded:

- **Headers** → `customResponseHeaders` on the `cypherkey-site-backend` backend bucket.
- **www → apex** → a `defaultUrlRedirect` in the `cypherkey-lb` URL map.
- **http → https** → the `cypherkey-http-redirect` URL map on the port-80 proxy.

If you add a header, add it to the backend bucket. There is no file in the repo that does
it any more, and re-adding one would be a second source of truth that silently loses.

**The CSP carries a script hash, and `site/csp.test.ts` guards it.** `site/index.html`
stamps the palette in `<head>` before first paint, so a visitor who chose dark does not
watch the page load light and swap. `script-src` is `'self'` with no `unsafe-inline`, so
the header names that one script by
`'sha256-mmJN3GwOEPpR6oAUsPnSozXTcUFPKLc4vUiwODCiL/A='`. Editing the script without
updating the header is silent in every way that matters — the page builds, deploys and
serves; only the browser refuses to run it. The test pins the hash so that edit fails
here instead. Update the header first, then the constant in the test.

    gcloud compute backend-buckets update cypherkey-site-backend \
      --project=<GCP_PROJECT_ID> \
      --custom-response-header="Content-Security-Policy: ..."

Note that `--custom-response-header` **replaces the whole list**: pass every header, not
just the one that changed.

**The bucket also needs `--web-main-page-suffix=index.html`.** Without it a request for
`/` returns the bucket's public XML object listing with a 200, which looks like a working
deploy until you read the content type.

## Cloud Armor

`cypherkey-armor` fronts the API. Two deliberate choices:

- **The per-IP throttle (100 req/min) is enforced.** It is behaviour-independent and
  cannot false-positive on payload content.
- **The OWASP preconfigured rules are in `preview` — logging, not blocking.** A
  zero-knowledge client posts base64 ciphertext, and SQLi/XSS signature rules are a
  well-known source of false positives against exactly that shape of body. A false
  positive here does not degrade a page; it silently breaks a user's vault sync. Read the
  Cloud Armor logs against real beta traffic before promoting any of them to enforcing.

## Running a deploy

Push to `main`, or trigger **Deploy** manually from the Actions tab. The workflow refuses
to roll forward unless migrations applied, the e2e passed against Cloud SQL, the image is
within the A-15 budget, and the new revision answers `/healthz`.

`/healthz` returns 503 when the database will not answer, so the startup probe gating the
rollout also proves the Cloud SQL socket works — a broken connection string fails the
deploy instead of a user's first login.

## Turning the X-3 failure email on

The server sends nothing until both `RESEND_API_KEY` and `MAIL_FROM` are set, and refuses
to start if only one of them is — half-configured mail is the state where an operator
believes the notice is going out. Confirm which state a revision is in from its first log
line: `cypherkey: mail is on, sending as …`, or `mail is off`.

**Send from a subdomain, not the apex.** `send.cypherkey.io` keeps transactional mail's
reputation separate from anything the apex ever does, and it means the apex SPF record
stays free for something else later. Resend's own guidance says the same.

Order matters: the secret has to exist before the revision that references it, or Cloud Run
fails to start the container and the deploy rolls back.

1. **In Resend** — create the account, add `send.cypherkey.io` as a domain, and copy the
   DNS records it shows. They are per-account (the DKIM public key is unique), so they
   cannot be written down here in advance. They are also not secret.
2. **Publish them** in the `cypherkey-io` zone. Typically an MX for the bounce path, an SPF
   `TXT` on the subdomain, and a DKIM `TXT` on `resend._domainkey.send.cypherkey.io`:

   ```bash
   gcloud dns record-sets create resend._domainkey.send.cypherkey.io. \
     --zone=cypherkey-io --type=TXT --ttl=300 --project=<GCP_PROJECT_ID> \
     --rrdatas='"<the DKIM value Resend shows>"'
   ```

   Then press Verify in Resend. Propagation is minutes, not hours, at TTL 300.

3. **Create the secret without the key touching a file, a shell history or a transcript** —
   the same way `JWT_SECRET` was created:

   ```bash
   printf '%s' '<paste the Resend API key>' \
     | gcloud secrets create RESEND_API_KEY --data-file=- --project=<GCP_PROJECT_ID>
   ```

4. **Grant the runtime account access to that secret alone** (never project-wide):

   ```bash
   gcloud secrets add-iam-policy-binding RESEND_API_KEY \
     --member=serviceAccount:<GCP_RUNTIME_SA> \
     --role=roles/secretmanager.secretAccessor --project=<GCP_PROJECT_ID>
   ```

5. **Uncomment** the `RESEND_API_KEY` and `MAIL_FROM` block in `service.yaml`, set
   `MAIL_FROM` to an address on the verified subdomain, and deploy.

6. **Check the log line**, which is the whole point of it existing:

   ```bash
   gcloud run services logs read cypherkey-api --region=us-central1 \
     --project=<GCP_PROJECT_ID> --limit=50 | grep 'cypherkey: mail'
   ```

To turn it off again, comment the block out and deploy. The secret can stay; nothing reads
it.

## What is deliberately not automated

- **The nameserver cutover.** Registrar-level, one-time, and it takes the domain down if
  it is wrong.
- **Secret rotation.** `JWT_SECRET` rotation invalidates every live session, so it is a
  decision rather than a job.
- **Cloud SQL schema drift.** Migrations only ever run forward, from the repo, in the
  deploy workflow. There is no automatic rollback: a bad migration is fixed by a new one.
