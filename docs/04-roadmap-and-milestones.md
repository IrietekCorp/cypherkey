# 04 — Roadmap and Milestones

Solo founder, >10 hrs/week, AI-assisted. Dates assume ~15 hrs/week; the model does most typing, you do review and testing. Every milestone has an **exit criterion** you can verify in 10 minutes. Ship nothing that fails its exit criterion.

## M0 — Demo Day (Sept 3 → Sept 14, 2026) · ~25 hours · **code complete**

> Build work is done (`core/biometrics/`, `site/`); the Sept 14 demo itself is still ahead — see `09-demo-script-sept14.md`.

**Goal:** a live website at cypherkey.io that demonstrates the party trick in the browser, plus a credible README and one-pager. The extension is *not* required for the demo; if it works, it's a bonus.

**Deliverables**
1. Landing page (static, Cloudflare Pages): one-liner, origin story, the live demo, roadmap, "star on GitHub," email capture.
2. **In-browser demo** (100% client-side, no accounts): enroll a passphrase 8 times with the Rhythm Light → "Now hand your laptop to someone" → they type it → score shown → you type it → score shown. Uses the real `core/` feature extraction and scoring code.
3. GitHub repo cleaned: README with the honest threat model summary, architecture diagram, license split, `docs/` containing files 02 and 03.
4. One-pager PDF for Jonathan (text in file 09).

**Exit criterion:** you can open cypherkey.io on a phone hotspot, run the demo with a stranger, and the stranger fails while you pass, 4 out of 5 times. The README's first screen answers "what, why, how is it safe."

**Not in M0:** server changes, extension, accounts, crypto rewrite. Do not touch them before the 14th.

## M1 — Foundation Rewrite (Sept 15 → Oct 20) · ~60 hours

**Goal:** the zero-knowledge core and the server that the extension will talk to. No UI beyond a minimal test harness.

- `core/crypto`: Argon2id, HKDF, AES-GCM wrap/unwrap, Ed25519 device keys, Recovery Kit derivation, with test vectors
- `core/biometrics`: capture (light-enforced), features, local scoring, serialization
- Server on Hono + Drizzle, SQLite and Postgres, all `/auth`, `/enroll`, `/vault`, `/user` routes from A-10
- Refresh tokens in DB, nonce log, rate limiting, lockouts, 500 ms floor
- **Phantom Keys** (A-14): full token set, HMAC commitments, server edit-distance check with alignment-aware rhythm scoring, Strictness setting (A-16), demo update
- Single-binary build, distroless image, size budgets in CI (A-15)
- `docker compose up` self-host path
- CI: `bun test`, typecheck, lint, `bun audit`

**Exit criterion:** an integration test script does signup (with a script containing two phantom keys; a second attempt using the resolved passphrase must fail) → enroll (8 samples) → login with a good sample (pass) → login with a bad sample (fail) → vault write → vault read on a second "device" → refresh → logout, against both SQLite and Postgres, in CI.

## M2 — Extension and Private Beta (Oct 21 → Dec 5) · ~70 hours

**Goal:** a password manager you would use yourself every day. 25 private beta users (friends, HN volunteers from the M0 email list).

- Extension (Chrome MV3, WXT framework): onboarding, Recovery Kit, enrollment, unlock with Rhythm Light, vault list/search, add/edit, autofill, generator, lock/idle
- Grey-band retype + step-up (recovery codes first; passkey/TOTP in M3)
- "Not your rhythm" email
- Import from Bitwarden/Chrome CSV
- Offline cache and sync per A-6/A-7
- Hosted server on Cloud Run + Cloud SQL (file 07), status page

**Exit criterion:** 25 beta users for 14 days; zero data-loss reports; median unlock time < 4 s; grey-band rate < 10% of logins; you personally have migrated your own vault and use it daily.

## M3 — Public Launch (Dec 6 → Jan 20, 2027) · ~50 hours

**Goal:** Show HN + Reddit + LinkedIn launch. Target: 5K GitHub stars, 1,000 free users.

- Adaptive per-user thresholds from score history; per-device profiles
- Step-up via passkey/platform authenticator and TOTP
- Pause mode, re-enrollment, accessibility path
- Rhythm Signature + consistency score in settings
- Precision Mode (feature-flagged)
- Firefox build (MV3 compatible via WXT)
- Security: external review of `core/crypto` (see file 07 for a low-cost path); public threat model page; `SECURITY.md` with disclosure policy
- Docs site; self-host guide; contributor guide

**Exit criterion:** launch post published; 48 hours later no P0 bugs; crypto review report published with findings resolved.

## M4 — Revenue and Reach (Jan 21 → Mar 31, 2027) · ~70 hours

- Stripe billing, Pro tier gates
- Breach check (HIBP k-anonymity)
- CLI (`cypherkey` on macOS/Linux/Windows) with terminal raw-mode rhythm capture
- Passkey storage in vault; cards and identities
- SSE sync push
- Emergency access (trusted contact)

**Exit criterion:** first 100 paying customers; CLI installs from Homebrew and a script; churn < 5%/mo.

## M5 — SDK and Progressive Enrollment (Apr → Jun 2027)

- npm SDK: `@cypherkey/sdk` with `<RhythmLight/>` component, `collectSamples: true` (consent-enforced), enrollment status API, verify API
- Service dashboard: enrollment coverage, score distribution, flip-the-switch
- Teams tier: shared collections, admin console, audit log export
- Rhythm-gated passkeys
- Hosted: Redis rate limiting, read replicas, load test to 10K concurrent

**Exit criterion:** three external services integrated; one paying.

## M6 — IdP and Mobile (Jul → Sep 2027)

- OIDC provider mode (Keycloak/Authentik positioning becomes real)
- Mobile read-only vault (React Native or Capacitor) with passkey unlock; touch rhythm research spike only
- SOC 2 readiness checklist; GDPR DPA template
- Native menu bar / tray apps if demand exists

## Milestone summary

| Milestone | Ends | Headline |
|---|---|---|
| M0 | Sep 14, 2026 | Live demo at cypherkey.io |
| M1 | Oct 20, 2026 | Zero-knowledge core + server, self-host in one command |
| M2 | Dec 5, 2026 | Daily-driver extension; 25 private beta users |
| M3 | Jan 20, 2027 | Public launch; 5K stars / 1K users target |
| M4 | Mar 31, 2027 | Paid tier live; CLI; 100 paying customers target |
| M5 | Jun 30, 2027 | SDK with Progressive Enrollment; first B2B integrations |
| M6 | Sep 30, 2027 | OIDC IdP; mobile read-only |

## Things that can slip without killing the plan

Firefox, CLI, breach check, Precision Mode, mobile. **Things that cannot slip:** zero-knowledge crypto (M1), autofill reliability (M2), step-up fallback (M2), crypto review before public launch (M3).
