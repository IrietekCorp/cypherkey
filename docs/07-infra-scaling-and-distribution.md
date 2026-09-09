# 07 — Infrastructure, Scaling, and Distribution

## I-1. Hosted stack on GCP (cheapest credible path)

| Layer | Choice | Monthly cost at launch | Why |
|---|---|---|---|
| Edge / DNS / DDoS / static site | **GCP** — Cloud CDN + Cloud Storage for the static site, Cloud Armor for DDoS | usage-based | Decided 2026-09-05: the marketing site is part of this application and lives where the rest of it does. Cloudflare Pages was the M0 answer and is retired; keeping the site on a second provider meant two deploy paths and two places to look when something broke |
| API | Cloud Run `cypherkey-api`, **min instances 1**, 1 vCPU / **1 GiB**, concurrency 20, region **us-central1**; single `bun --compile` binary in a distroless image | $15–20 | **As built, M2-16.** Scale-to-zero was the M0 plan and is wrong here: Argon2id at m=64 MiB on a cold start looks broken, and a login is the first thing anyone does. 512 MB is also wrong — each in-flight hash holds 64 MiB, so the default 80-per-instance concurrency OOMs; 20 against 1 GiB leaves headroom |
| Database | Cloud SQL Postgres 16 `cypherkey-db`, `db-f1-micro` (shared core, **Enterprise edition** — Enterprise Plus rejects shared-core tiers), automated backups + PITR, 7-day retention | ~$10–15 | Same schema as self-host SQLite via Drizzle. Public IP with **zero authorized networks**: the only route in is the Cloud SQL Auth proxy authenticated by IAM |
| Secrets | Secret Manager | ~$0 | `JWT_SECRET`, Resend, Stripe |
| Email | Resend free tier (3k/mo) | $0 | "Not your rhythm" + recovery emails |
| Rate limit / cache | DB-backed until M5, then Memorystore Redis (~$35) or Upstash (~$0–10) | $0 | |
| Monitoring | Cloud Monitoring + Uptime checks; Sentry free tier | $0 | |
| Status page | Betterstack or Instatus free tier | $0 | Security buyers look for it |
| CI | GitHub Actions free for public repos | $0 | |

**Launch-month total: roughly $15–40.** First serious cost step is Redis at M5.

**As deployed (M2-16, 2026-09-07).** Project `<GCP_PROJECT_ID>` (number `<GCP_PROJECT_NUMBER>`),
region `us-central1`. The service definition is `deploy/service.yaml` and the pipeline is
`.github/workflows/deploy.yml`; both are the source of truth, and a console edit is
reverted by the next deploy. One-time console setup is recorded in an operations log
kept outside this repository. CI
authenticates through Workload Identity Federation restricted to this repository — there
is no long-lived service-account key anywhere. DNS is Cloud DNS (zone `cypherkey-io`),
not the registrar.

One trap worth carrying forward: **postgres.js ignores a `?host=` query parameter**, so
the connection string every Cloud Run guide shows silently dials TCP `localhost` instead
of the Cloud SQL socket. The service passes `PGHOST`/`PGUSER`/`PGPASSWORD` separately for
that reason. `deploy/README.md` has the detail.

**Why not Firestore?** No Drizzle support means two data layers (one for SQLite self-host, one for hosted) — double the bug surface for a cheaper model; per-read/write billing spikes on login-heavy, sync-polling, nonce-churning traffic; hot-document contention for rate-limit counters. Pre-launch, Neon's free Postgres tier gives scale-to-zero pricing with zero code change. Decision recorded in docs/02 A-15.

Why not Cloud Run + SQLite (Litestream)? Multiple instances can't share a SQLite file; the moment you set `max-instances > 1` you need Postgres. Drizzle makes that free, so start there for hosted and keep SQLite for self-host.

## I-2. Scaling triggers (what to change, and when)

| Signal | Action |
|---|---|
| p95 API latency > 800 ms (excluding the 500 ms floor) | Cloud Run: raise min instances to 2 first. **Do not raise concurrency to 80 without raising memory to match** — 80 concurrent Argon2id hashes at 64 MiB each is 5 GiB, and the instance OOMs long before latency improves |
| Cloud SQL CPU > 60% sustained | Upgrade to `db-custom-1-3840`; add read replica for `/vault/changes` GETs |
| > 5,000 DAU | Move rate limiting and nonce log to Redis; enable SSE via Cloud Run WebSockets/HTTP streaming |
| > 50,000 users | Partition `vault_items` by `user_id` hash; move ciphertext blobs > 64 KB to Cloud Storage with signed URLs |
| Any single-region outage concern | Second region behind a GCP external load balancer; Postgres cross-region replica |

Because the server holds only ciphertext and scoring is a few hundred float ops, the per-request cost is tiny. The scaling constraints are Argon2id (client-side, not our CPU) and database writes for score history — batch those into a single insert per login.

## I-3. Operational must-haves before public launch (M3)

- Backups verified by an actual restore drill (document it in the repo; buyers love this)
- `SECURITY.md`, `security@cypherkey.io`, a PGP key, 90-day disclosure policy
- Public threat model page (from A-11) and a plain-English "What we can and cannot see" page
- Reproducible extension builds; publish build hashes in releases
- Dependency pinning; Renovate or Dependabot; `bun audit` in CI
- Incident runbook: rotate `JWT_SECRET` (mass logout), revoke all refresh tokens, disable signups
- Low-cost security review: (a) post the crypto design to r/crypto and the Bitwarden/KeePass communities for critique before writing code; (b) commission a focused 2–3 day review of `core/crypto` and the auth flow from an independent reviewer — expect low four figures; (c) bounty later. Publish the report either way.

## I-4. Distribution plan

### Viral loops built into the product
1. **Party Trick** — the demo is the ad. Every enrolled user gets a "show a friend" screen. Every landing page visitor can try it in 60 seconds.
2. **"Not your rhythm" email** — the first time it fires, users screenshot it. Make it beautiful.
3. **Self-host in one command** — r/selfhosted posts write themselves.
4. **Open threat model** — security people share things that admit limits.

### Launch sequence (M3, mid-January 2027)
| Day | Channel | Asset |
|---|---|---|
| −14 | Private beta users asked to prepare comments; a Bitwarden/KeePass community post asking for crypto critique (this is both review and pre-marketing) | Crypto design doc |
| −7 | Blog post: "I built a keystroke captcha at CBS Sports in 2010. Here's what it became." | Long-form, personal |
| 0 (Tue, 8–9am PT) | **Show HN: CypherKey – open-source password manager where your password only works when you type it** | Landing page + demo + repo. Founder present in comments all day, answering every crypto question honestly |
| 0 | r/privacy, r/selfhosted, r/Bitwarden ("I built an alternative"), r/MechanicalKeyboards (Precision Mode angle) | Tailored posts, not cross-posts |
| 0 | LinkedIn: the origin story, 60-second demo video, ask for reshares from your own network | Target 10K likes |
| +1 | Product Hunt | Reuse assets |
| +3 | Podcasts/newsletters: Security Now, Risky Business, tl;dr sec, Console.dev, Changelog | Pitch the honest-limits angle |
| +7 | Follow-up post: "What HN taught us; here's what we changed" | Turns criticism into a second wave |

### Ongoing
- Monthly "Rhythm Report" blog: anonymized aggregate stats (grey-band rate, adaptation improvements) — content that is also transparency
- Conference talks: BSides, DEF CON Demo Labs (May deadline), PasswordsCon
- Integrations as distribution (M5): Keycloak/Authentik plugins put the SDK in front of every self-hosted IdP user
- Chrome Web Store listing optimized for "password manager without phone 2FA"

### Metrics to track from day one
Installs, enrollment completion rate, unlock success by band, grey-band rate, step-up usage, day-7 and day-30 retention, stars, self-host pulls (Docker Hub), email list, paid conversion.

## I-5. Monetization mechanics

- Stripe Checkout + Customer Portal; entitlements stored on `users.plan`; feature flags checked client-side and enforced server-side (device count, breach check)
- Annual default, monthly available
- Self-hosters never pay and never hit a paywall; that's the AGPL deal and the source of goodwill
- Enterprise later: support contract + hosted dedicated instance, not feature gating of security

## I-6. Legal checklist before charging money

Terms, privacy policy with a "Rhythm data" section, biometric consent record retention, DPA template, cookie-free analytics (Plausible or none), Delaware LLC/C-corp before VC conversations, trademark search for "CypherKey."
