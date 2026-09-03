# AGENTS.md — CypherKey engineering conventions

You are working on CypherKey, an open-source zero-knowledge password manager with keystroke-rhythm authentication. Read this file at the start of every session. It overrides your defaults.

## Non-negotiables (security)

1. **The server never sees plaintext vault data, the master key, the wrap key, or the passphrase.** If a change would send any of these to the server, stop and say so.
2. **Raw keystroke events and feature vectors are never persisted or logged**, on client or server. Only profile aggregates and scalar scores are stored. Tests assert this.
3. **No keystroke capture without a visible Rhythm Light.** `startCapture` throws if the light element is not visible. Never bypass this, even in tests — use a visible stub element.
4. **No insecure defaults.** The server exits if `JWT_SECRET` is missing or short. Never add a fallback secret.
5. **Crypto comes from `core/crypto` only.** Use WebCrypto and `@noble/*`. Do not implement primitives. Do not use `Math.random` for anything security-related. Do not add crypto libraries not already in `package.json`.
6. **Constant-time comparisons** for any secret comparison (`crypto.timingSafeEqual` on server, `@noble/hashes/utils` `equalBytes` in core).
7. **Zero key material on lock.** Any function holding `masterKey`, `wrapKey`, `vaultKey`, or a device private key must `fill(0)` on lock/error paths.

## Scope discipline

- Work only on the ticket in front of you. Do not refactor, rename, reformat, or "improve" code outside the ticket's file list.
- Do not add dependencies the ticket doesn't name. If you believe one is necessary, say so and stop.
- Do not invent API endpoints, env vars, or table columns. They are defined in `docs/02-architecture-and-threat-model.md`. If the ticket needs something not there, say so.
- If the ticket is ambiguous, state one assumption in one line and proceed. Do not ask multiple questions.
- Never leave TODOs that hide missing security behavior. Either implement it or fail loudly.

## Repository layout

```
core/        platform-agnostic client logic (MIT)   — no DOM imports except core/biometrics/capture.ts
  crypto/    kdf, aead, device, recovery
  biometrics/ features, score, capture
  client/    session state machine, sync engine, storage interface
server/      Bun + Hono + Drizzle (AGPL-3.0)
extension/   WXT (Chrome/Firefox MV3), React, Tailwind (MIT)
site/        marketing site + in-browser demo (Vite)
docs/        architecture, experience, threat model
scripts/     e2e, migrations, release
```

## Stack

- Bun 1.x, TypeScript strict, ESM only
- Server: Hono, Drizzle ORM (SQLite via `bun:sqlite`, Postgres via `postgres`), Zod
- Client crypto: WebCrypto (AES-GCM, HKDF where available), `@noble/hashes` (argon2id, hkdf, sha256), `@noble/curves` (ed25519)
- Extension: WXT, React 18, Tailwind
- Tests: `bun test`; DOM tests use `happy-dom`
- Lint/format: Biome

## Code style

- Small pure functions. Side effects at the edges (routes, UI handlers).
- Every exported function has a one-line JSDoc stating what it guarantees.
- Errors are typed results (`{ error: 'code' }`) in `core/`; thrown `HTTPException` in server routes.
- No `any`. No non-null assertions on untrusted input. Validate every request body with Zod.
- Byte strings are `Uint8Array`. Base64url for transport (`core/crypto/encoding.ts`).
- Feature vector order and length are defined in `core/biometrics/features.ts`; never duplicate the ordering logic.

## Testing rules

- Write the test file named in the ticket **before** implementation.
- Tests must not depend on network, time of day, or randomness (inject `now()` and `random()` where needed).
- Server tests run against SQLite by default and Postgres when `DATABASE_URL` is set; both must pass.
- Add a test that asserts the absence of forbidden data (e.g., "no row in any table contains a feature vector after login").

## Definition of done (paste the outputs)

1. `bun test` — all green
2. `bun run typecheck` — clean
3. `bun run lint` — clean
4. `git diff --stat` — only files in the ticket
5. One-paragraph summary: what was built, what assumption was made, what remains

## Words

Product name is **CypherKey** (spelled with y, never i). Env vars are `CYPHERKEY_*`. The biometric profile is "your Rhythm." The capture indicator is "the Rhythm Light." Passive enrollment is "Progressive Enrollment" (never "silent").
