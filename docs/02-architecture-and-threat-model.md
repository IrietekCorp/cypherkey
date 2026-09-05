# 02 — Architecture and Threat Model (v1.2)

This replaces sections 2, 3, and 7 of the original PROJECT.MD. The building model should treat this document as the source of truth; tickets reference section numbers here (e.g., "see A-2.3").

## A-1. Design principles

1. **Zero-knowledge.** The server stores only ciphertext and verifiers. It cannot decrypt a vault, cannot derive the master key, and cannot forge a client signature.
2. **Biometric enforcement lives on the server, biometric data lives nowhere raw.** The server scores feature vectors but never stores them; it stores only the irreversible profile aggregate and scalar scores.
3. **Two-key separation.** The key that authenticates you is not the key that decrypts your vault. Compromise of the auth path never yields plaintext.
4. **Wrap, don't derive.** The vault is encrypted with a random key that is *wrapped* by the passphrase-derived key. Changing your passphrase or adding a recovery key re-wraps one 32-byte key, not the whole vault.
5. **One codebase, two databases.** SQLite for self-host and dev; Postgres for hosted. Same schema via an ORM, no forks.
6. **No capture without the light.** The client never records keystroke timing unless the Rhythm Light component is mounted and visible. This is enforced in code, not policy (see `03`, X-1).

## A-2. Key hierarchy (client-side only)

All of this runs in the client (extension, CLI, SDK). The server never sees any value in this section except `authHash` and the wrapped keys.

```
passphrase (user memory)
   │
   ▼  Argon2id(kdfInput, salt=userSalt, m=64MiB, t=3, p=1)     ← userSalt is random 16B, stored server-side, fetched by username pre-auth
      kdfInput = resolved passphrase (Medium/Relaxed), or resolved ‖ U+0000 ‖ script (Strict). See A-14.2.
masterKey (32B, memory only, never leaves client)
   │
   ├── HKDF(masterKey, info="cypherkey/auth/v1")  → authKey (32B)
   │        └── sent to server at login as authHash; server stores Argon2id(authHash)
   │
   ├── HKDF(masterKey, info="cypherkey/wrap/v1")  → wrapKey (32B)
   │        └── AES-256-GCM unwrap → vaultShare (32B, random at signup)
   │                 vaultKey = vaultShare XOR serverShare      ← serverShare comes from the server (A-5)
   │
   └── HKDF(masterKey, info="cypherkey/phantom/v1") → phantomKey (32B)   ← A-14.2

vaultKey encrypts every vault item:  AES-256-GCM(item, vaultKey, nonce=random 12B, aad=itemId)
recoveryKey (32B, from the Recovery Kit code) → wraps the FULL vaultKey, not the share
recoveryAuthHash = HKDF(recoveryKey, "cypherkey/recovery-auth/v1") → proves possession of the Kit;
                     server stores Argon2id(recoveryAuthHash), exactly as it does for authHash (M2-00f)

every wrapped key is AEAD-bound to its purpose:  aad = "cypherkey/wrap/vault-key/v1" | "cypherkey/wrap/device-key/v1"
                                                     | "cypherkey/wrap/vault-key-offline/v1"   ← A-7 cache: wraps the FULL vaultKey, not the share
```

Rationale for Argon2id over PBKDF2: memory-hard, resists GPU cracking, and the salt is random rather than the username.

**One Argon2 implementation, everywhere (decided, v1.2).** `core/` uses **`hash-wasm`** (`argon2id`) in the browser, in the extension and under Bun. Tests therefore exercise the same compiled code the extension ships, so a green test is evidence about production rather than about a second implementation that merely agrees today. `argon2-browser` and the pure-JS `@noble/hashes` Argon2 path are both withdrawn. `@noble/hashes` stays, and is the only source of HKDF, HMAC and SHA-256. The server still hashes `authHash` with `Bun.password`; that is a server-side verifier, not part of the client key hierarchy.

Measured on the reference machine: `hash-wasm` at m=64 MiB, t=3, p=1 takes **~175 ms**, against **~1,010 ms** for the pure-JS path it replaces. The A-15 budget is 700 ms on a 2020 laptop.

**Argon2 parameters are per account.** `m`, `t` and `p` are recorded alongside `userSalt` and returned by `GET /auth/salt`, so an account keeps the parameters it was created with and a global default change never locks anyone out. Raising them for an existing user changes `masterKey` and is therefore a **re-key**, not a settings edit: it runs the same flow as switching to Strict (M1-17c) — re-derive, re-wrap `vaultKey`, re-register `authHash`, re-send commitments, bump `key_version` — and requires a step-up.

**Why authHash is hashed again on the server:** if the DB leaks, an attacker gets `Argon2id(authHash)`, which cannot be replayed as `authHash`.

**Wrapped keys are domain-separated (decided in M1-04).** The same `wrapKey` seals both `vaultShare` (A-2) and the device private key (A-3). Both are 32 opaque bytes, so without separation a swapped blob unwraps as the other secret and the client cannot tell. Every `wrapKey`/`unwrapKey` call therefore passes a context label as AES-GCM associated data; `core/crypto/aead.ts` owns the closed set of labels.

**Why the vault key is split but the Recovery Kit is not (decided, v1.2).** What the client wraps under `wrapKey` is a random `vaultShare`, never `vaultKey` itself; the server generates `serverShare` at signup and returns it in the 201 and on every later successful login. That is what makes the rhythm *enforcing*: passphrase alone reconstructs nothing. The **Recovery Kit is the deliberate exception** — the client computes `vaultKey` the moment it holds the 201, wraps the full `vaultKey` under `recoveryKey`, and registers that blob in a second call before enrollment may proceed. Consequence, stated plainly: the Recovery Kit plus the server ciphertext opens the vault **without the server agreeing to release the share**, so an encrypted export can carry the full vault key and a user can leave hosted CypherKey and still open their data. That is the AGPL promise and X-5 in concrete form. Yes, this bypasses the biometric: the Kit is 160 random bits held offline, not an online guessing target, and an attacker holding both a DB dump and your printed Kit has already won by other means. Every other path — passphrase-only, device-only — still needs the server to release the share after the rhythm passes.

## A-3. Device identity and request signing

Each device generates an **Ed25519 keypair** at first unlock. The public key is registered with the server during the first authenticated session. The private key is stored in extension storage encrypted with `wrapKey` (so it's useless without the passphrase).

**Implementation (corrected in M1-05).** Signing uses `@noble/curves` unconditionally. The earlier wording — "WebCrypto `Ed25519` where available, `@noble/curves` fallback" — is not reachable: WebCrypto cannot import or export a raw 32-byte Ed25519 private seed (`InvalidAccessError` on export, `SyntaxError` on import), only PKCS#8, while our device key is raw bytes. WebCrypto remains a *second* implementation in tests, where it verifies our signatures and, given a test-only PKCS#8 wrapper, produces byte-identical ones — Ed25519 being deterministic makes that a real equality. RFC 8032 §7.1 vectors are committed.

Every authenticated request is signed:

```
msg = "cypherkey-sig-v1" \n hex(nonce) \n ts \n METHOD \n path-with-query \n hex(sha256(body))
signature = Ed25519.sign(devicePriv, UTF8(msg))
```

Fields are newline-delimited and version-prefixed so no two different requests can produce the same signing string. An empty body hashes the empty byte string. `path-with-query` never includes scheme or host.

**Transport (settled in M1-07).** The signature and its inputs travel in **headers**, never in the body:
`x-cypherkey-device` (device id), `x-cypherkey-nonce` (base64url), `x-cypherkey-ts`, `x-cypherkey-signature` (base64url).
This is forced, not stylistic: the signing string covers `sha256(body)`, so a `deviceSig` field *inside* the body would have to be signed before it exists. A-5 step 3 lists `deviceSig`, `nonce` and `ts` alongside the login fields — read that as what is transmitted, not as body members.

Server verifies against the registered device public key, checks nonce uniqueness (60s window) and timestamp skew (±30s). This replaces the HMAC-with-passphrase-key design; the server holds no symmetric secret that could forge a client.

## A-4. Biometric pipeline

### A-4.1 Capture (client)
- `keydown`/`keyup` timestamps via `performance.now()` (sub-ms).
- Captured only for the passphrase field, only while the Rhythm Light is mounted.
- Raw events are discarded after feature extraction. They are never persisted or transmitted.

### A-4.2 Features (client, `core/biometrics/features.ts`)

*n* is the **script token count** (A-14.1), not the resolved passphrase length. The resolved length is never sent to the server, never stored, and is not derivable from anything the server holds.

- Dwell: `n` values (keyup − keydown per token)
- Flight: `n−1` values (next keydown − keyup)
- Digraph: `n−1` values (next keydown − keydown)
- Globals: exactly seven, in this order — `totalTime, meanDwell, stdDwell, meanFlight, stdFlight, meanDigraph, stdDigraph`. All seven carry weight 0.5.
- Vector is length **`3n + 5`**, fixed order, float32. Serialized as JSON array for MVP.

  The arithmetic, written out because it was got wrong once: `n + (n−1) + (n−1) = 3n − 2` timing features, plus the 7 globals, is `3n + 5`. n=6 → 23; n=12 → 41. This is what `core/biometrics/features.ts` has always produced. A v1.2 draft briefly said `3n + 7`, which is the same seven globals with the wrong sum; `3n + 7` is wrong everywhere it appears.

**Rule (v1.2): no count-based or token-class globals, ever.** A backspace count would tell the server how many Backspace tokens are in the script, which breaks A-14's guarantee that the server learns the script *length* and nothing else about its contents. Backspace is an ordinary token with ordinary timing features and no special treatment anywhere in the pipeline. Samples containing Backspace are **never** rejected.

`core/biometrics/features.ts` is the single definition of this layout. Nothing else — server scoring, alignment, tests, the demo — re-derives the ordering or the length; they import it.

### A-4.3 Profile (server, `biometric_profiles`)
Per feature: mean, standard deviation (floored at a minimum of 8 ms to avoid division blowups), and weight. Built from **enrollment samples** (default 8, min 5, max 20; `ENROLLMENT_SAMPLES` env). Samples are deleted after profile build.

### A-4.4 Scoring (server, `src/biometrics/score.ts`)
```
for each feature i: z_i = |x_i − mean_i| / std_i
featureScore_i = 1 / (1 + (z_i / k)^2)          // k=2.0; smooth, bounded 0..1
score = weighted mean of featureScore_i          // weights: dwell 1.0, flight 1.5, digraph 1.0, globals 0.5
```
Decision bands (per-user, adaptive after M3; defaults below):
- `score ≥ 0.62` → **pass**
- `0.45 ≤ score < 0.62` → **grey**: step-up required (see 03, X-3)
- `score < 0.45` → **fail**: counts toward lockout; notify user

### A-4.5 Adaptation
After a **pass** with score ≥ 0.70, update profile via EMA (`α = 0.1`) toward the new sample. Never adapt on grey or fail. Cap adaptation to once per 10 minutes per user. This prevents an attacker from slowly walking the profile toward themselves while tracking natural drift.

**Partially defective; see M2-00g.** The gap between the 0.62 pass band and the 0.70 adapt threshold is much less harmful than it looks, because per-login variation carries a drifting user over 0.70 often enough to pull the profile along. Measured over 200 trials of 60 logins, with ordinary adaptation and nothing else:

| Drift | Fresh score | Samples ≥ 0.70 | Recovered | Median logins |
|---|---|---|---|---|
| 6% slower | 0.760 | 95.0% | 100% | 0 |
| 10% slower | 0.675 | 23.5% | 100% | 7 |
| 12% slower | 0.627 | 1.3% | 47% | 42 |
| 14% slower | 0.572 | 0.0% | **0%** | never |

So adaptation self-heals everything down to about 0.65. The real failure is *below* the pass band: a user at 0.572 never produces an adaptable sample, is sent to step-up on every login, and stays there permanently — the profile can never learn the drift that is causing the step-ups. **A-4.5's "never adapt on grey" is the actual defect**, because a grey attempt followed by a *successful step-up* is a more strongly verified user than a bare 0.70 pass. Note the precise shape of the gap: `/auth/step-up` **already** folds a cleared *retype* into the profile, but only when the averaged score reaches the pass band — so the 0.572 user fails the retype too and never reaches it. The factors that clear a step-up *without* a rhythm score — a Backup Code today, passkey or TOTP in M3 — are the ones that can rescue them, and those paths currently learn nothing at all.

This also resolves a standing contradiction: **docs/03 X-3 already specifies the correct behaviour** — "on success: in, *and* the two samples are added to the profile (this is how the profile learns your new keyboard)" — and A-4.5 contradicted it. The implementation followed A-4.5, so the shipped behaviour is the wrong one. Where the two disagree here, X-3 is right and this section is being corrected to match it, rather than the usual direction.

**The variance is frozen.** `adapt()` EMAs the means and copies `stds` through unchanged, so modelled variability stays at its one-sitting enrolment value forever. Measured, correcting this is worth little on its own (a stuck user reaches 0.724 rather than 0.717, and the owner's own score drops slightly), so it is a correctness matter rather than a fix for drift.

**Never widen the band deliberately.** Asking a user to contribute fast and slow enrolment samples raises per-feature `std`, and a wider band admits *everyone*: six natural samples plus one slow and one fast moved a stranger from 0.453 to 0.840 while median std went 8 ms → 21.4 ms. Real variability is learned from real logins, never injected at enrolment.

### A-4.7 Signal provenance
Every input to an auth decision is either **unforgeable** — a device Ed25519 signature, a server-generated nonce, a value derived from the passphrase — or **self-reported**: a claimed platform string, a user agent, a keyboard or layout identifier, a WebHID vendor id. Self-reported signals are attacker-controlled JSON and may inform *which profile to score against*, never *whether to admit*. A per-keyboard or per-device profile is a usability mechanism; the device signature remains the security boundary.

Note also that the browser cannot identify a keyboard as hardware. WebHID exposes a vendor and product id only behind a per-device permission prompt, `navigator.keyboard.getLayoutMap()` reports layout rather than device, and nothing exposes switch type — the property that actually moves typing rhythm. Where distinguishing keyboards matters, cluster on the rhythm itself.

### A-4.6 What the server keeps
| Kept | Not kept |
|---|---|
| Profile aggregate (means, stds, weights) | Raw keystroke events |
| Scalar score per auth (`auth_score_history`) | Feature vectors |
| Enrollment samples (temporary, deleted on build) | Any per-key timing after build |

## A-5. Authentication and vault-key release

The biometric factor protects two things: the session, and the **server-held share** of the vault key. This is what makes the biometric *enforcing* for vault access, not just advisory.

```
vaultShare = wrapKeyUnwrap(wrappedVaultKey)
vaultKey   = vaultShare XOR serverShare
```

**Signup handshake (v1.2).** The client generates a random `vaultShare`, wraps it under `wrapKey`, and posts it. The server generates `serverShare` (32B random) and returns it in the **201**. The client XORs to get `vaultKey`, wraps that full key under `recoveryKey`, and registers `recoveryWrappedVaultKey` via **`POST /auth/recovery-key`** (added to A-10 in M1-07; the original single-call signup body could not carry it, because the client cannot know `serverShare` until the 201 arrives). **Enrollment cannot begin until that blob is registered** — otherwise a user could get a vault they can never recover.

- `wrappedVaultKey` lives on the server (ciphertext, wrapped by client `wrapKey`); its plaintext is `vaultShare`, never `vaultKey`.
- `serverShare` (32B random) is stored server-side in plaintext but **released only after passphrase + rhythm (or step-up) succeed**.
- An attacker with the passphrase alone gets neither the wrapped key (needs auth) nor the share.
- An attacker with a full DB dump gets `serverShare` and `wrappedVaultKey` but not `wrapKey` (needs passphrase + Argon2id). Still zero-knowledge.
- A **trusted, previously-unlocked device** caches `vaultKey` wrapped under `wrapKey` in local storage so that offline unlock works with passphrase alone (see A-7). This is the documented trade-off: offline = "a device you already trusted."

### Login sequence (online)
1. `GET /auth/salt?username=` → `userSalt`, `argonParams`, device-registration status
2. Client derives `masterKey`, `authKey`, `wrapKey`; captures rhythm while typing
3. `POST /auth/login` `{ username, authHash, featureVector, deviceId, deviceSig, nonce, ts }`
4. Server: verify authHash → verify device sig (or start new-device flow) → score → band
5. **pass**: return `{ accessToken (15m), refreshToken (30d, DB-stored, rotating), wrappedVaultKey, serverShare }`
   **grey**: return `{ stepUp: ["retype", "recovery_code", "totp", "passkey"] }`
   **fail**: 401, increment lockout counter, email/notify user
6. Client unwraps, XORs, holds `vaultKey` in memory; locks after idle timeout (default 15 min) by zeroing memory.

Responses padded to ≥ 500 ms on all paths.

## A-6. Sync

**Model:** the vault is an append-only, per-item encrypted change log. Each item has `{ id, version, updatedAt, deletedAt?, ciphertext, nonce }`. The server is a dumb, authenticated blob store with a monotonic `cursor` per user.

**Endpoints:** `GET /vault/changes?since=cursor`, `POST /vault/changes` (batch upsert with per-item version check → 409 on conflict).

**Cursor (M1-12).** `vault_cursors.cursor` is the user's monotonic counter; every written item is stamped with the next value in `vault_items.cursor`, which is what `GET ?since=` filters and orders on. `updated_at` is client-supplied and cannot be trusted to order a log.

**Conflict rule:** the two halves of this operate at different layers, which is easy to misread. On the wire the server does an **optimistic version check**: a write carries the `version` the client believes the server holds, and a mismatch is a `409` carrying the server's copy — the server never merges, because it cannot read either side. **Last-writer-wins by `updatedAt`, ties broken by `deviceId`,** is then the *client's* resolution rule applied to that 409 before it retries. Conflicted losers are kept as a "previous version" in the item history (client-side) for 30 days so nothing is silently lost.

**Sync triggers (client):** on unlock, after any local write (debounced 2s), on window focus, every 5 min while unlocked, and via SSE push (`GET /vault/events`) in M4. All triggers no-op when offline and queue local writes.

**Bandwidth:** items are small; a 2,000-item vault is < 2 MB. Full sync is fine until M5.

## A-7. Offline mode

- Extension caches the encrypted change log in IndexedDB (ciphertext only).
- Caches `vaultKey` wrapped under `wrapKey` (AES-GCM) after the first successful online unlock on that device.
- Offline unlock: passphrase → `wrapKey` → unwrap cached `vaultKey`. Rhythm is scored **locally** against a cached copy of the profile (advisory: shows a warning band in the UI, logs a score for later upload, but cannot enforce because a local attacker controls the client). Document this plainly in the threat model UI.
- Writes queue and sync on reconnect.

## A-8. Server stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Bun 1.x + TypeScript | Already chosen; fast; built-in SQLite and password hashing |
| HTTP | Hono | Runs on Bun and Cloud Run identically; middleware ecosystem |
| ORM | Drizzle | One schema, SQLite (`bun:sqlite`) and Postgres (`postgres.js`) drivers |
| Validation | Zod | Shared with `core/` for request/response types |
| Sessions | JWT access (15m, HS256 with `JWT_SECRET`) + rotating refresh tokens in DB | Refresh table gives persistent revocation from day one — removes the in-memory list |
| Rate limiting | Per-IP and per-account token bucket in `rate_limits` (SQLite) or Redis (hosted, M5). 100 req/min per IP, 10 login attempts/min per account. The client IP is read from `x-forwarded-for`, which is only trustworthy behind our own proxy — a directly reachable deployment must not rely on the per-IP bucket. | |
| Email | Resend | Free tier is fine until thousands of users |
| Billing | Stripe Checkout + webhooks | M4 |

Self-host: `docker compose up` gives server + SQLite in one container, volumes for DB. That single command is a marketing feature.

**Postgres is never in the image.** The server image ships Bun and the binary; hosted deployments reach a *managed* Postgres over the network via `DATABASE_URL`. Development and local `bun test` run on SQLite alone — no Postgres is installed — and the Postgres suites skip with a printed reason. Both drivers are exercised only in CI, against a `postgres:16` service container.

## A-9. Schema (Drizzle)

| Table | Key columns |
|---|---|
| `users` | id, username(unique), email, user_salt, argon_params, auth_hash (argon2), wrapped_vault_key (wraps `vaultShare`), recovery_wrapped_vault_key (wraps the full `vaultKey`), recovery_auth_hash (argon2, proves Kit possession), server_share, key_version, biometric_enabled, biometric_paused_until, thresholds_json, consent_at, consent_policy_version, created_at |
| `devices` | id, user_id, public_key, name, platform, trusted_at, last_seen_at, revoked_at |
| `biometric_profiles` | user_id, script_len, means[], stds[], weights[], script_commitments, sample_count, version, updated_at |
| `enrollment_samples` | id, user_id, feature_vector, script_commitments (both deleted on build), created_at — the first sample fixes the canonical commitment sequence and every later one must match it exactly |
| `auth_score_history` | id, user_id, device_id, score, band, created_at |
| `vault_items` | **primary key (user_id, id)**, cursor, version, ciphertext, nonce, updated_at, deleted_at — item ids come from the client, so they are unique only within an account; a global key would let one account claim an id and lock others out of it |
| `vault_cursors` | user_id, cursor |
| `refresh_tokens` | id, user_id, device_id, token_hash, expires_at, revoked_at, replaced_by |
| `nonces` | nonce, user_id, seen_at (pruned > 5 min) |
| `step_up_factors` | id, user_id, type (totp/passkey), secret_enc, created_at — see A-17 for what `secret_enc` holds per type. Backup Codes are **not** here: a one-time code needs a one-way hash, not a reversible secret |
| `users.recovery_auth_hash` | `Argon2id(recoveryAuthHash)` — the verifier checked before `/auth/recover` releases or changes anything. Nullable only for accounts predating M2-00f; it is written in the same one-shot call as the blob, so no account can hold a blob nobody can prove title to |
| `backup_codes` | id, user_id, code_hash (unique), used_at, created_at — X-3's ten one-time codes, stored as `base64url(sha256(normalized))`. A Backup Code opens a **session**; the Recovery Kit opens a **vault**, and the two are never named alike |
| `lockouts` | user_id, failed_count, locked_until |
| `rate_limits` | key (HMAC of scope+value under the server secret), tokens, updated_at — the DB token buckets A-8 calls for; neither an IP nor a username is stored in the clear |
| `audit_log` | id, user_id, event, ip_hash, device_id, created_at |

Removed from original: `credentials` (replaced by `vault_items`, no server-side key derivation), `enroll_tokens` (replaced by refresh tokens with scope), in-memory revocation.

**Transactions on SQLite must use a synchronous callback.** `bun:sqlite` is a synchronous driver, and Drizzle's sqlite `transaction()` given an *async* callback returns before the promise settles: the writes then land outside transactional control and a throw rolls back nothing at all. Measured during M2-00f, where it would have silently defeated the one-transaction requirement while every test still passed. Any multi-write route therefore needs a synchronous body with explicit `.run()` on sqlite and the ordinary awaited body on Postgres — two branches, as elsewhere in the schema layer. `server/src/routes/recover.ts` is the reference, and `recover.test.ts` has the regression test that forces a mid-transaction failure.

## A-10. API surface (M1–M3)

```
GET   /auth/salt
POST  /auth/signup            {username,email,authHash,userSalt,wrappedVaultKey,devicePub,consentAt,consentPolicyVersion}  → 201 {userId, serverShare, enrollmentToken, backupCodes[10]}
POST  /auth/recovery-key      {recoveryWrappedVaultKey, recoveryAuthHash}   ← second leg of signup (A-5);
                              one-shot, both land together; enrollment refused until it exists
POST  /auth/recover/begin     {username, recoveryAuthHash} → {recoveryWrappedVaultKey, serverShare}
                              READ-ONLY. Verifies first, alters nothing. M2-00f
POST  /auth/recover           {username, recoveryAuthHash, newAuthHash, newUserSalt, newWrappedVaultKey, devicePub, …}
                              Verifies, then deletes TOTP factors, revokes devices, registers the new one,
                              rotates authHash/salt/wrappedVaultKey, drops the profile — all in one transaction.
                              Same 500 ms floor and lockout as /auth/login. Backup Codes survive.
POST  /auth/login
POST  /auth/step-up           {username, authHash, method:'retype', featureVector, commitments}
                              {username, authHash, method:'backup_code', proof}       ← M2-00e; passkey/TOTP are M3.
                              A failed attempt of either kind counts toward lockout (M2-00e closed that hole).
                              Like /auth/refresh it takes no access token — a grey login issues none —
                              and re-proves the passphrase plus the A-3 device signature instead.
                              On success the access token carries `stepUpAt`, which PATCH /user/settings requires.
POST  /auth/refresh
POST  /auth/logout
GET   /enroll/status
POST  /enroll/sample          {featureVector}   → {samplesRemaining}
POST  /enroll/build
GET   /vault/changes?since=
POST  /vault/changes
GET   /vault/events           (SSE, M4)
GET   /user/settings
PATCH /user/settings          {biometricEnabled, pauseUntil, thresholds}   ← refuses Strict; that is a re-key
POST  /user/rekey             {strictness, authHash, wrappedVaultKey, commitments}  ← M1-17c; needs a fresh step-up.
                              Crossing into or out of Strict changes kdfInput and so masterKey (A-16). vaultKey itself
                              does not change, so recoveryWrappedVaultKey stays valid. Bumps users.key_version, which is
                              how other devices learn their A-7 offline cache is stale.
POST  /auth/recover/begin     {username, recoveryAuthHash} → {recoveryWrappedVaultKey, serverShare}
                              READ-ONLY: touches no factor, device, key or profile. Same lockout and
                              500 ms floor as /auth/login; an unknown user answers exactly as a wrong Kit.
POST  /auth/recover           {username, recoveryAuthHash, newAuthHash, newUserSalt, newWrappedVaultKey,
                              devicePub, deviceName, devicePlatform} → {userId, serverShare, enrollmentToken}
                              One transaction: delete TOTP factors, revoke every device and refresh token,
                              register the presenting device, write the new key material and bump
                              key_version, delete the profile and samples. Backup Codes are untouched.
                              Two calls because the client cannot compute newWrappedVaultKey until it has
                              unwrapped vaultKey, and the server cannot re-wrap on its behalf.
GET   /user/backup-codes      → {remaining}   ← a count, never the codes
POST  /user/backup-codes      {authHash}  → {backupCodes[10]}   ← regenerate; invalidates every previous
                              code. A-17: the passphrase travels in this request, not a flag minted earlier.
GET   /user/devices
DELETE /user/devices/:id
GET   /user/rhythm            {sampleCount, recentScores[], consistency}
GET   /healthz
```

All routes except `/auth/salt`, `/auth/signup`, `/auth/login`, `/healthz` require access token **and** device signature.

## A-11. Threat model

| Threat | Mitigation | Residual risk (say this out loud) |
|---|---|---|
| Passphrase leaked (dark web) | Rhythm check + device trust + step-up | Attacker who can watch you type and has a trusted device is out of scope |
| Credential stuffing / replay | Nonce + timestamp + Ed25519 device sig; feature vector bound to session | None for replay |
| Hosted DB dump | Zero-knowledge: Argon2id(authHash), wrapped keys, random salts | Offline brute-force of weak passphrases; mitigated by Argon2id params + zxcvbn strength meter at signup |
| Server secrets (`JWT_SECRET`) leaked with DB | Vault still unreadable; sessions forgeable until rotated | Rotate secret; refresh tokens in DB allow mass revoke |
| Malicious server (hosted operator) | Cannot read vault; cannot forge device sig; can deny service or lie about scores | Users who care self-host — that's the AGPL promise |
| TOTP secrets in a DB dump | Encrypted under `stepUpKey = HKDF(authHash, …)`, which is derivable only from a value the user supplies at auth; the DB holds `Argon2id(authHash)` and ciphertext (A-17) | **A DB dump reveals no TOTP secrets without the user's passphrase.** A *live* malicious operator does see `authHash` at login and could derive the key then — the guarantee is about the dump, not the operator |
| Profile inversion | Aggregates only; no vectors stored | Aggregates leak coarse typing speed; low value |
| Biometric drift → lockout | Adaptation + grey-band step-up + Pause | User loses Recovery Kit and all step-ups: permanent loss (by design, disclosed) |
| Timing side channel on auth | 500 ms floor on all responses | |
| Compromised browser / OS keylogger | Out of scope; stated plainly | |
| Phishing site | Domain-bound autofill; never fill on non-matching origin; warn on lookalikes (punycode) | Same posture as every password manager |
| Malicious extension update / supply chain | Reproducible builds, pinned deps, `bun audit` in CI, signed releases (M5) | |
| SDK operator collecting without consent | SDK refuses to capture unless a Rhythm Light element is rendered and the consent flag is set; documented for BIPA/GDPR | Operators can fork the MIT SDK — we can't stop that, but the reference behavior is correct |

## A-12. Regulatory posture (moved up from Phase 4)

- **Consent:** explicit, written-form consent captured at signup and at first Progressive Enrollment sample (checkbox + stored timestamp + policy version). Retention policy published: profile deleted within 30 days of account deletion; enrollment samples deleted at build.
- **GDPR Art. 9:** keystroke profile used to identify a person is special-category data — explicit consent is the lawful basis. Data minimization is architectural (aggregates only).
- **Illinois BIPA:** written consent, published retention schedule, no sale. Illinois amended BIPA in 2024 to limit damages to per-person rather than per-scan; still treat it as the strictest US regime.
- **CCPA/CPRA:** biometric data is "sensitive personal information"; provide the limit-use right.
- Add a "Rhythm data" section to the privacy policy written in plain English, and link it from the Rhythm Light tooltip.

## A-13. Environment

| Variable | Default | Notes |
|---|---|---|
| `CYPHERKEY_SERVER_URL` | `http://localhost:3000` | client |
| `PORT` | `3000` | |
| `DATABASE_URL` | `sqlite://./cypherkey.db` | `postgres://…` for hosted |
| `JWT_SECRET` | none — **server refuses to start without it** | ≥32 random bytes |
| `ENROLLMENT_SAMPLES` | `8` | 5–20 |
| `SCORE_PASS` / `SCORE_GREY` | `0.62` / `0.45` | overridden per-user in M3 |
| `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | none | hosted only |

`ENCRYPTION_KEY` is **removed**. The server no longer participates in credential encryption. Insecure defaults are removed; the server exits with a clear message if a required secret is missing.

## A-14. Phantom Keys (the keystroke script as a second, fuzzy-verified secret)

**Definition.** The *script* is the ordered sequence of key tokens physically typed into the passphrase field, corrections included. The *resolved passphrase* is the text a normal form would receive. Phantom Keys are the tokens in the script that don't survive into the resolved text (an extra letter and the Backspace that removes it, a lone Escape, a tap of Ctrl).

**Token rules (A-14.1).** A keydown produces a token when all three hold: (1) it has an ASCII code, (2) it does not move focus, (3) it is not a chord.

**Pair on the physical key, not the character (learned the hard way, M1-18 follow-up).** `KeyboardEvent.key` is the character produced *at that instant*, so a passphrase like `Proleteri@te$` breaks a naive implementation three times over: press Shift, press P, release **Shift first**, and the keyup reports `p` while the keydown reported `P`. Paired on `key` the two never meet, the `P` looks pressed-and-never-released, and a correctly typed sample is voided. Capture therefore records `KeyboardEvent.code` and pairing uses it, while tokenization still uses `key` — the character is what reaches the field, the physical key is what identifies the keystroke. Left and right Shift are tracked separately for the same reason.
| Token class | Encoding | Notes |
|---|---|---|
| Printable ASCII 0x20–0x7E | the character | Shift held to produce a capital yields the uppercase character; Shift is not a separate token in that case |
| Backspace | U+0008 | |
| Delete | U+007F | |
| Escape | U+001B | Capture must `preventDefault` so it doesn't close a popup |
| Lone modifier tap (down/up with no other key while held) | U+E000 Shift, U+E001 Ctrl, U+E002 Alt, U+E003 Meta, U+E004 CapsLock | Private-use code points; Alt alone can steal focus on some platforms — the blur rule below handles it |
| Ctrl/Alt/Meta + key chords | — | **Cancel the sample** (`unsupported_combo`), reserved for a future feature |
| Tab, Enter (terminator), arrows, Home/End/PageUp/PageDown, F-keys, Insert, paste/drop, IME composition | — | Cancel the sample (`unsupported_key`) |
| Any `blur` on the field during capture | — | Cancel the sample (`focus_lost`). This is how "does not remove focus" is enforced without a per-OS key list |

**Caret model (A-14.1, v1.2).** Every key that could move the caret cancels the sample, so **the caret is always at the end of the resolved text**. Therefore: Backspace removes the last resolved character, and is a no-op on resolved text when the field is empty (still a token either way); Delete at end-of-text is always a no-op, so **Delete is always a pure phantom**; Escape and lone modifier taps are likewise always pure phantoms. Resolution needs no caret tracking — it is a left-to-right fold over the token sequence.

**Secrets (A-14.2).**
- `masterKey = Argon2id(kdfInput, salt)` where `kdfInput = resolvedPassphrase` in Medium/Relaxed, and `kdfInput = resolvedPassphrase || U+0000 || script` in Strict. A wrong resolved passphrase therefore always fails, in every mode.
- `phantomKey = HKDF(masterKey, "cypherkey/phantom/v1")`.
- **The Recovery Kit has two branches, and only one of them unwraps anything:**
  ```
  recoveryKey      = HKDF(recoverySecret, "cypherkey/recovery/v1")        // unwraps the vault
  recoveryAuthHash = HKDF(recoveryKey,    "cypherkey/recovery-auth/v1")   // proves possession
  ```
  The server stores `Argon2id(recoveryAuthHash)` in `users.recovery_auth_hash`, exactly as it stores `Argon2id(authHash)`. Chained off `recoveryKey` rather than a sibling of it purely to reuse the tested `recoveryKeyFromCode()`; HKDF is one-way either way, so the stored verifier reveals nothing about the wrap key. This is what makes recovery *server-authenticated*: without it, `POST /auth/recover` would hand the wrapped vault key to anyone who could name a username, turning the server into an oracle that distributes the encrypted vault key on request.
- **All three branches are derived in one Argon2id pass and `phantomKey` is held in memory for the life of the unlock.** It is a sibling of `authKey` and `wrapKey`, so a client that holds only the KDF *input* cannot commit a script without running Argon2id again at m=64 MiB — doubling the cost of every unlock on the popup and the phone, which are the contexts least able to absorb it. A client API therefore takes the credential (`resolved`, `script`, `strictness`) rather than pre-built KDF bytes. `phantomKey` is memory-only: never persisted, never sent, zeroed on lock, exactly like `vaultKey`.
- Script commitments: `c_i = HMAC-SHA256(phantomKey, token_i)` truncated to 16 bytes, for each token in order. The client sends `[c_1..c_n]` at enrollment (canonical) and at every login.
- The server stores the canonical commitment sequence and compares at login (A-14.3). It cannot recover tokens (needs `phantomKey` → `masterKey` → passphrase). It can see the *equality pattern* of tokens (repeated characters hash identically). This is the disclosed leak; it reveals no token identities and no positions of phantoms relative to the resolved text.
- **Commitments are static across sessions** — the same script always produces the same `[c_1..c_n]`. They therefore contribute *no* replay resistance of their own and rely entirely on the A-3 nonce and device signature for freshness. Do not mistake a matching commitment sequence for proof of a live typist.

**Verification (A-14.3).**
1. Server verifies `authHash` (fails hard on wrong passphrase).
2. Server aligns canonical against login commitments (edit distance with path), counting `ins` (extra login tokens), `del` (canonical tokens absent) and `sub` separately — **not** as one symmetric number. See A-16 for why.
   *Note on step 4:* the server never receives raw timings, only the feature vector — and it does not need them. `digraph[i]` is `down[i+1] − down[i]` and `dwell[i]` is `up[i] − down[i]`, so the whole down/up sequence follows from an arbitrary origin (`flight[i]` is just `digraph[i] − dwell[i]`, carrying no independent information). That is what makes "recompute from the retained neighbours" implementable without asking the client for anything more.
3. Budget from the user's Strictness (A-16): `ins ≤ t` **and** `del + sub ≤ m`. Exceeding either → **fail** (counts toward lockout; never grey).
4. Within budget, the alignment path drives rhythm scoring, per op:
   - `match` — dwell, flight and digraph used as-is.
   - `ins` — **bridge across it.** Drop the inserted token's dwell entirely (no feature, no weight), and recompute the flight and digraph that span it from the retained neighbours: `flight = next.down − prev.up`, `digraph = next.down − prev.down`.
     *Corrected in M1-17b, having been measured:* bridging is the **stricter** rule, not the more forgiving one. The recomputed gap includes however long the fumble took, so the cost to the score scales with that time — 0 for a stray key fast enough to fit inside the existing rhythm, and about 0.08 for one costing 60 ms. Neutralizing the spanning pair instead would score *higher* for a slow fumble, because it discards the evidence that the rhythm really was disturbed. Keeping that evidence is the point, so bridging stands; the earlier rationale ("a lone extra keystroke perturbs two values, not four") described the arithmetic but implied leniency that does not exist.
   - `del` — the missing dwell and **both** touching flight/digraph pairs are neutralized: feature score 0.5 at half weight.
   - `sub` — timing features kept, position flagged.
   Globals are recomputed from the **aligned** token set (post-bridge), so both sides of the comparison are `3·canonLen + 7`. Rhythm scoring then proceeds per A-4.4 on the aligned vector.
5. Only if both script and rhythm pass is `serverShare` released.

Errors that change the resolved text (a forgotten Backspace) are not "phantom errors": they fail at step 1. Tolerance therefore only ever forgives resolved-text-preserving slips, which is the intended behavior.

**Enrollment.** The script is typed twice; both must be token-identical (client-side, constant-time compare) → canonical. Rhythm samples must match canonical exactly during enrollment (tolerance applies to login only, so the profile is clean). The client shows "12 keystrokes · 8 characters".

**Display.** The field masks the *resolved* length. An observer sees 8 dots for a 12-keystroke script.

**Switching Strictness** to or from Strict changes `kdfInput` and therefore `masterKey`: the client re-derives, re-wraps `vaultKey` (cheap, per A-1 principle 4), re-registers `authHash`, and re-sends commitments. Requires a step-up. Medium ↔ Relaxed changes only server-side tolerance.

**Threat model deltas.**
| Threat | Effect of Phantom Keys |
|---|---|
| Password leaked from another site / dark web, used online | Attacker must also guess the phantoms within `t`, under rate limiting → strong improvement in all modes |
| Shoulder surfing | Sees resolved length only → improvement |
| DB dump + leaked resolved passphrase | Medium/Relaxed: attacker can derive `phantomKey` and brute-force each commitment (~100 candidates per position) → phantoms add nothing here, but the vault was already lost in this scenario. Strict: `masterKey` needs the exact script → vault still protected. Say this on the Strictness screen |
| Keylogger | Captures the script → unchanged, out of scope |

## A-15. Build, size, and speed budget

| Target | Budget | How |
|---|---|---|
| Server binary | single file via `bun build --compile --minify --target=bun`. **< 95 MB total, and < 8 MB of our own payload** (measured M1-19: 79.4 MB total, of which the Bun 1.4 runtime is 77.0 MB and our code 2.4 MB) | The original "< 60 MB incl. runtime" is unreachable: Bun's runtime alone exceeds it, and `strip` recovers 0.1 MB. The total mostly tracks Bun releases; the **payload** is the number a new dependency moves, so it is budgeted separately and is what actually catches a regression |
| Server container | `gcr.io/distroless/cc-debian12` runtime stage, **< 130 MB**, non-root (`nonroot`, uid 65532) | Multi-stage: the binary is compiled on `oven/bun:1` so it links against the same glibc, then copied into distroless. 100 MB was set against the old 60 MB binary figure; the base is ~30 MB and the binary 79 MB. No shell, so no `HEALTHCHECK` — the orchestrator probes `/healthz` |
| Cold start (Cloud Run) | < 300 ms to first response | Bun startup + lazy DB connect; no schema sync at boot (migrations run in CI/deploy job, not on start) |
| Extension popup JS | < 250 KB gzipped, first paint < 100 ms | WXT/Vite code-splitting; `hash-wasm` Argon2 module (11.6 KB gzipped, measured) fetched and compiled when the popup opens, in parallel with passphrase entry; no moment/lodash/heavy UI kits; Tailwind purged |
| Site (cypherkey.io) | < 120 KB total, Lighthouse ≥ 95 | Vanilla TS demo, no framework |
| Argon2id in browser | < 700 ms on a 2020 laptop | `hash-wasm` at m=64 MiB, t=3, p=1 — measured ~175 ms under Bun on the reference machine. Runs in a Web Worker, never on the popup main thread; module compiled during passphrase entry so the cost at submit is the hash alone; show a progress affordance |
| Login round trip | 500 ms floor (timing defense) + network; target p95 < 900 ms | Single DB transaction per login; score-history insert batched into it |

Enforce with `scripts/size-check.ts` in CI (fails the build on regression) — `bun run size-check`. It prints a table and exits non-zero on a breach, and CI posts it to the run summary along with the container image size. A budget with no measurement counts as a failure rather than being skipped, so a target cannot quietly stop being enforced. Never add a dependency without stating its gzipped size in the PR.

**Database decision (recorded):** Postgres for hosted, SQLite for self-host, one Drizzle schema. Firestore was evaluated and rejected: no Drizzle support (two data layers), per-operation pricing that spikes under login/sync/nonce churn, hot-document contention for counters. For pre-launch scale-to-zero, Neon's Postgres free tier is acceptable from Cloud Run with no code change; move to Cloud SQL when there is revenue or a residency requirement.

## A-16. Strictness setting (one control for phantoms and rhythm)

Stored in `users.thresholds_json`; changed via `PATCH /user/settings` with a fresh step-up flag. Three positions; **Medium is the default**.

**Why the budget is asymmetric (v1.2).** A symmetric edit distance cannot express what we actually want. The benign slip — you fumble a key and correct it — is an *insertion* of two tokens (`x` then `⌫`). The attack — someone holds your leaked resolved passphrase and types only that — is a *deletion* of your phantoms. With two phantoms, both are distance 2. Any symmetric threshold that forgives your typo also admits the attacker. So insertions and deletions are budgeted separately: extra keystrokes are cheap, missing ones are not.

The rule in one sentence: **everything you enrolled must still be there, in order; you are allowed up to `t` extra keystrokes on top.**

| Level | Extra tokens `t` (n = canonical script length) | Missing/changed `m` | Rhythm pass / grey | KDF input | Who it's for |
|---|---|---|---|---|---|
| **Strict** | 0 | 0 | 0.70 / 0.55 | resolved ‖ script | Power users, Precision Mode keyboards, people who want phantoms to protect the vault even in a breach |
| **Medium** (default) | `max(2, floor(n/6))` | **0** | 0.62 / 0.45 | resolved | Everyone |
| **Relaxed** | `max(4, floor(n/3))` | **1** | 0.55 / 0.40 | resolved | Accessibility, people with variable typing, new keyboards |

Worked examples: n=10 → Medium `t`=2, Relaxed `t`=4. n=12 → 2 / 4. n=25 → 4 / 8.

At **Medium**, one typo-and-correct (`x⌫`, two insertions) is forgiven, a lone stray Escape or Ctrl tap is forgiven, and *no* missing or altered token ever is. At **Relaxed** one missing Phantom Key is also forgiven — so a Relaxed user with fewer than two phantoms gets no phantom protection against a leaked resolved passphrase. Say that on the Strictness screen.

**Minimum phantoms.** Because Relaxed forgives one deletion, phantom protection is only meaningful from **two phantoms up**. Enrollment warns below two and blocks at zero. The passphrase floor is unchanged and lives in `03` X-2 (≥ 12 resolved characters, zxcvbn ≥ 3/4); phantoms only ever add tokens, so the script is always at least that long.

UI: a three-position slider labeled Strict · Medium · Relaxed with one sentence under each. Changing to Strict shows the "this changes your master key; keep your Recovery Kit handy" warning and requires step-up. Rhythm and phantom thresholds may be split into two sliders later if beta data says users want them independent; keep one control until then.

## A-17. Step-up factor storage (decided; implemented with TOTP in M3)

`step_up_factors.secret_enc` promised a reversible secret with no key to reverse it — A-13 removed `ENCRYPTION_KEY`. This is how each factor is actually stored.

**Passkeys** store the credential public key and signature counter **in plaintext**. Nothing about a public key needs encrypting, and the counter is not a secret.

**Backup Codes** (X-3's ten one-time codes) are not stored here at all. They live in `backup_codes` as `sha256` hashes — one-way, never decrypted, so they need no key. See M2-00e.

**TOTP secrets** are AES-256-GCM encrypted under a key the server can only derive while the user is proving who they are:

```
stepUpKey = HKDF(authHash, info="cypherkey/stepup/v1")
ciphertext = AES-256-GCM(totpSecret, stepUpKey, nonce = random 12B, aad = user_id || factor_id)
```

`authHash` arrives in the request; the server stores only `Argon2id(authHash)`. So `stepUpKey` exists for the scope of one request that presented the passphrase-derived value, and is never persisted, never cached and never logged. At rest the database holds ciphertext and a verifier, and neither yields the other.

There is no `STEP_UP_KEK`, no KMS and no server-held key material. That is the point: adding one would put the thing back that A-13 took out.

**Consequences, each of which is a requirement.**

1. **Every flow that changes `authHash` must re-wrap every TOTP secret in the same transaction.** The client presents the old and the new `authHash` in one request; the server decrypts under the old `stepUpKey` and re-encrypts under the new one, or the whole change rolls back. This applies to the M1-17c Strict re-key and to any future passphrase change. The client must therefore still be able to derive the *old* `authHash` at that moment — for a Strictness change it can, since it holds the resolved text and the script and needs only the previous level.

2. **Any settings change gated on step-up must present the passphrase in that same request**, not merely carry a step-up flag minted earlier: Pause, Strictness, Backup Code regeneration, TOTP enrolment. Without `authHash` in hand the server cannot derive `stepUpKey`, so a token flag alone is not enough for the factor-touching ones — and one rule for all of them is easier to reason about than a rule per setting. *This differs from what M1-13 shipped*, which accepts a `stepUpAt` claim up to five minutes old; see the correction in `05`.

3. **Recovery Kit recovery destroys TOTP factors, by construction.** The Kit path exists precisely because the passphrase is gone, so the old `authHash` cannot be derived and the secrets cannot be re-wrapped. Recovery therefore **deletes every TOTP factor** and the user re-enrols; leaving them behind would hand the account an undecryptable second factor and lock it out permanently. Backup Codes survive untouched, being hashes. Say this on the recovery screen (`03` X-5).
