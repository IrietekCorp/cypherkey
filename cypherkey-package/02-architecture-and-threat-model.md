# 02 — Architecture and Threat Model (v1.0)

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
   ▼  Argon2id(passphrase, salt=userSalt, m=64MiB, t=3, p=1)   ← userSalt is random 16B, stored server-side, fetched by username pre-auth
masterKey (32B, memory only, never leaves client)
   │
   ├── HKDF(masterKey, info="cypherkey/auth/v1")  → authKey (32B)
   │        └── sent to server at login as authHash; server stores Argon2id(authHash)
   │
   └── HKDF(masterKey, info="cypherkey/wrap/v1")  → wrapKey (32B)
            └── AES-256-GCM unwrap → vaultKey (32B, random at signup)

vaultKey encrypts every vault item:  AES-256-GCM(item, vaultKey, nonce=random 12B, aad=itemId)
recoveryKey (32B random, shown once as Recovery Kit) → also wraps vaultKey (second wrapped copy)
```

Rationale for Argon2id over PBKDF2: memory-hard, resists GPU cracking, and the salt is random rather than the username. In the extension use `argon2-browser` (WASM) or the WebCrypto-free `@noble/hashes` Argon2 implementation; in Bun use the built-in `Bun.password` for server-side hashing and `@noble/hashes` for parity in `core/`.

**Why authHash is hashed again on the server:** if the DB leaks, an attacker gets `Argon2id(authHash)`, which cannot be replayed as `authHash`.

## A-3. Device identity and request signing

Each device generates an **Ed25519 keypair** at first unlock (WebCrypto `Ed25519` where available; `@noble/curves` fallback). The public key is registered with the server during the first authenticated session. The private key is stored in extension storage encrypted with `wrapKey` (so it's useless without the passphrase).

Every authenticated request is signed:

```
signature = Ed25519.sign(devicePriv, nonce || timestamp || method || path || SHA256(body))
```

Server verifies against the registered device public key, checks nonce uniqueness (60s window) and timestamp skew (±30s). This replaces the HMAC-with-passphrase-key design; the server holds no symmetric secret that could forge a client.

## A-4. Biometric pipeline

### A-4.1 Capture (client)
- `keydown`/`keyup` timestamps via `performance.now()` (sub-ms).
- Captured only for the passphrase field, only while the Rhythm Light is mounted.
- Raw events are discarded after feature extraction. They are never persisted or transmitted.

### A-4.2 Features (client, `core/biometrics/features.ts`)
For a passphrase of length *n*:
- Dwell: `n` values (keyup − keydown per key)
- Flight: `n−1` values (next keydown − keyup)
- Digraph: `n−1` values (next keydown − keydown)
- Globals: total time, mean/std of dwell, mean/std of flight, backspace count (a correction is a strong signal — a sample with >0 backspaces is rejected from enrollment but allowed at verify with a small penalty)
- Vector is length `3n + 5`, fixed order, float32. Serialized as JSON array for MVP.

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

### A-4.6 What the server keeps
| Kept | Not kept |
|---|---|
| Profile aggregate (means, stds, weights) | Raw keystroke events |
| Scalar score per auth (`auth_score_history`) | Feature vectors |
| Enrollment samples (temporary, deleted on build) | Any per-key timing after build |

## A-5. Authentication and vault-key release

The biometric factor protects two things: the session, and the **server-held share** of the vault key. This is what makes the biometric *enforcing* for vault access, not just advisory.

```
vaultKey = wrapKeyUnwrap(wrappedVaultKey)  XOR  serverShare
```

- `wrappedVaultKey` lives on the server (ciphertext, wrapped by client `wrapKey`).
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

**Conflict rule:** per-item last-writer-wins by `updatedAt`, ties broken by `deviceId`. Conflicted losers are kept as a "previous version" in the item history (client-side) for 30 days so nothing is silently lost.

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
| Rate limiting | Per-IP and per-account token bucket in DB (SQLite) or Redis (hosted, M5) | |
| Email | Resend | Free tier is fine until thousands of users |
| Billing | Stripe Checkout + webhooks | M4 |

Self-host: `docker compose up` gives server + SQLite in one container, volumes for DB. That single command is a marketing feature.

## A-9. Schema (Drizzle)

| Table | Key columns |
|---|---|
| `users` | id, username(unique), email, user_salt, auth_hash (argon2), wrapped_vault_key, recovery_wrapped_vault_key, server_share, biometric_enabled, biometric_paused_until, thresholds_json, created_at |
| `devices` | id, user_id, public_key, name, platform, trusted_at, last_seen_at, revoked_at |
| `biometric_profiles` | user_id, passphrase_len, means[], stds[], weights[], sample_count, version, updated_at |
| `enrollment_samples` | id, user_id, feature_vector (deleted on build), created_at |
| `auth_score_history` | id, user_id, device_id, score, band, created_at |
| `vault_items` | id, user_id, version, ciphertext, nonce, updated_at, deleted_at |
| `vault_cursors` | user_id, cursor |
| `refresh_tokens` | id, user_id, device_id, token_hash, expires_at, revoked_at, replaced_by |
| `nonces` | nonce, user_id, seen_at (pruned > 5 min) |
| `step_up_factors` | id, user_id, type (totp/recovery_codes/passkey), secret_enc, created_at |
| `lockouts` | user_id, failed_count, locked_until |
| `audit_log` | id, user_id, event, ip_hash, device_id, created_at |

Removed from original: `credentials` (replaced by `vault_items`, no server-side key derivation), `enroll_tokens` (replaced by refresh tokens with scope), in-memory revocation.

## A-10. API surface (M1–M3)

```
GET   /auth/salt
POST  /auth/signup            {username,email,authHash,userSalt,wrappedVaultKey,recoveryWrappedVaultKey,devicePub}
POST  /auth/login
POST  /auth/step-up           {method, proof}
POST  /auth/refresh
POST  /auth/logout
GET   /enroll/status
POST  /enroll/sample          {featureVector}   → {samplesRemaining}
POST  /enroll/build
GET   /vault/changes?since=
POST  /vault/changes
GET   /vault/events           (SSE, M4)
GET   /user/settings
PATCH /user/settings          {biometricEnabled, pauseUntil, thresholds}
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
