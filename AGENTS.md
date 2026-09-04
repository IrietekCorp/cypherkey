# AGENTS.md — CypherKey engineering conventions

You are working on CypherKey, an open-source zero-knowledge password manager with keystroke-rhythm authentication. Read this file at the start of every session. It overrides your defaults.

## Non-negotiables (security)

1. **The server never sees plaintext vault data, the master key, the wrap key, or the passphrase.** If a change would send any of these to the server, stop and say so.
2. **Raw keystroke events and feature vectors are never persisted or logged**, on client or server. Only profile aggregates and scalar scores are stored. Tests assert this.
3. **No keystroke capture without a visible Rhythm Light.** `startCapture` throws if the light element is not visible. Never bypass this, even in tests — use a visible stub element.
4. **No insecure defaults.** The server exits if `JWT_SECRET` is missing or short. Never add a fallback secret.
5. **Crypto comes from `core/crypto` only.** Use WebCrypto and `@noble/*`. Do not implement primitives. Do not use `Math.random` for anything security-related. Do not add crypto libraries not already in `package.json`.
6. **Constant-time comparisons** for any secret comparison (`crypto.timingSafeEqual` on server, `equalBytes` from `core/crypto/encoding.ts` in core — it re-exports `@noble/curves/abstract/utils`, since `@noble/hashes/utils` has no such export).
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
  crypto/    kdf, aead, device, recovery, encoding (base64url, utf8, constant-time compare)
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

Product name is **CypherKey** (never CipherKey). Env vars are `CYPHERKEY_*`. The biometric profile is "your Rhythm." The capture indicator is "the Rhythm Light." Passive enrollment is "Progressive Enrollment" (never "silent").

## Phantom Keys (read before touching passphrase input, KDF, enrollment, login, or scoring)

The **resolved passphrase** is the KDF input (plus the exact script in Strict mode). The **script** (all tokens per docs/02 A-14.1, including Backspace, Delete, Escape, and lone modifier taps) is verified separately through per-token HMAC commitments compared server-side with edit-distance tolerance from the user's Strictness (A-16). Never send tokens, the script, or the resolved passphrase to the server; only `authHash` and commitments. Never reject Backspace from samples. Chords (Ctrl/Alt/Meta+key), Tab, Enter, arrows, paste, and any `blur` cancel a sample — they are user-facing retries, not errors. Rhythm scoring on a login whose script length differs from the profile must use the alignment path from the commitment comparison (A-14.3); never truncate or pad vectors.

## Diagnostics

There is a `?debug=1` panel in `site/demo.ts` that shows why each sample was accepted or rejected. It exists in the demo and nowhere else. `core/` has no debug hook, so it cannot reach the extension, which imports `core/` and never `site/`. It holds only a throwaway phrase the visitor invented on a page with no account, it writes to no storage, it logs to no console, and it sends nothing anywhere.

**Do not build an equivalent in the extension or the server.** Real feature vectors, scripts and commitments are exactly what A-4.1 and A-14 say must never be surfaced, and a runtime flag would be the wrong control there — it would have to be stripped at build time. Extension diagnostics stop at band, score and error code.

## Size discipline

Every PR states the gzipped size delta. CI fails on budget regression (docs/02 A-15). Prefer `@noble/*`, Hono, and hand-written code over general-purpose libraries. Lazy-load Argon2 WASM. No dependency additions without the ticket naming them.
