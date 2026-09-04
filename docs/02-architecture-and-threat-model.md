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
recoveryKey (32B random, shown once as Recovery Kit) → wraps the FULL vaultKey, not the share

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
- Vector is length **`3n + 7`**, fixed order, float32. Serialized as JSON array for MVP.

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

**Postgres is never in the image.** The server image ships Bun and the binary; hosted deployments reach a *managed* Postgres over the network via `DATABASE_URL`. Development and local `bun test` run on SQLite alone — no Postgres is installed — and the Postgres suites skip with a printed reason. Both drivers are exercised only in CI, against a `postgres:16` service container.

## A-9. Schema (Drizzle)

| Table | Key columns |
|---|---|
| `users` | id, username(unique), email, user_salt, argon_params, auth_hash (argon2), wrapped_vault_key (wraps `vaultShare`), recovery_wrapped_vault_key (wraps the full `vaultKey`), server_share, key_version, biometric_enabled, biometric_paused_until, thresholds_json, consent_at, consent_policy_version, created_at |
| `devices` | id, user_id, public_key, name, platform, trusted_at, last_seen_at, revoked_at |
| `biometric_profiles` | user_id, script_len, means[], stds[], weights[], script_commitments, sample_count, version, updated_at |
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
POST  /auth/signup            {username,email,authHash,userSalt,wrappedVaultKey,devicePub,consentAt,consentPolicyVersion}  → 201 {userId, serverShare}
POST  /auth/recovery-key      {recoveryWrappedVaultKey}   ← second leg of signup (A-5); enrollment refused until it exists
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

## A-14. Phantom Keys (the keystroke script as a second, fuzzy-verified secret)

**Definition.** The *script* is the ordered sequence of key tokens physically typed into the passphrase field, corrections included. The *resolved passphrase* is the text a normal form would receive. Phantom Keys are the tokens in the script that don't survive into the resolved text (an extra letter and the Backspace that removes it, a lone Escape, a tap of Ctrl).

**Token rules (A-14.1).** A keydown produces a token when all three hold: (1) it has an ASCII code, (2) it does not move focus, (3) it is not a chord.
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
- Script commitments: `c_i = HMAC-SHA256(phantomKey, token_i)` truncated to 16 bytes, for each token in order. The client sends `[c_1..c_n]` at enrollment (canonical) and at every login.
- The server stores the canonical commitment sequence and compares at login (A-14.3). It cannot recover tokens (needs `phantomKey` → `masterKey` → passphrase). It can see the *equality pattern* of tokens (repeated characters hash identically). This is the disclosed leak; it reveals no token identities and no positions of phantoms relative to the resolved text.
- **Commitments are static across sessions** — the same script always produces the same `[c_1..c_n]`. They therefore contribute *no* replay resistance of their own and rely entirely on the A-3 nonce and device signature for freshness. Do not mistake a matching commitment sequence for proof of a live typist.

**Verification (A-14.3).**
1. Server verifies `authHash` (fails hard on wrong passphrase).
2. Server aligns canonical against login commitments (edit distance with path), counting `ins` (extra login tokens), `del` (canonical tokens absent) and `sub` separately — **not** as one symmetric number. See A-16 for why.
3. Budget from the user's Strictness (A-16): `ins ≤ t` **and** `del + sub ≤ m`. Exceeding either → **fail** (counts toward lockout; never grey).
4. Within budget, the alignment path drives rhythm scoring, per op:
   - `match` — dwell, flight and digraph used as-is.
   - `ins` — **bridge across it.** Drop the inserted token's dwell entirely (no feature, no weight), and recompute the flight and digraph that span it from the retained neighbours: `flight = next.down − prev.up`, `digraph = next.down − prev.down`. Nothing is neutralized, so a lone extra keystroke perturbs two values, not four.
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
| Server binary | single file via `bun build --compile --minify --target=bun`, < 60 MB incl. runtime | No `node_modules` shipped; Hono (~15 KB), Drizzle, `postgres`, Zod, `@noble/*` only |
| Server container | `gcr.io/distroless/cc` or `oven/bun:alpine` runtime stage, < 100 MB, non-root | Multi-stage Dockerfile; binary copied in |
| Cold start (Cloud Run) | < 300 ms to first response | Bun startup + lazy DB connect; no schema sync at boot (migrations run in CI/deploy job, not on start) |
| Extension popup JS | < 250 KB gzipped, first paint < 100 ms | WXT/Vite code-splitting; `hash-wasm` Argon2 module (11.6 KB gzipped, measured) fetched and compiled when the popup opens, in parallel with passphrase entry; no moment/lodash/heavy UI kits; Tailwind purged |
| Site (cypherkey.io) | < 120 KB total, Lighthouse ≥ 95 | Vanilla TS demo, no framework |
| Argon2id in browser | < 700 ms on a 2020 laptop | `hash-wasm` at m=64 MiB, t=3, p=1 — measured ~175 ms under Bun on the reference machine. Runs in a Web Worker, never on the popup main thread; module compiled during passphrase entry so the cost at submit is the hash alone; show a progress affordance |
| Login round trip | 500 ms floor (timing defense) + network; target p95 < 900 ms | Single DB transaction per login; score-history insert batched into it |

Enforce with `scripts/size-check.ts` in CI (fails the build on regression). Add `bun build --analyze` output to PR summaries. Never add a dependency without stating its gzipped size in the PR.

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
