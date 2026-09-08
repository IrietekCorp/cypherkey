# 05 — Work Tickets (sized for Sonnet / Gemini)

## How these tickets are shaped, and why

Less capable models fail in predictable ways: they scope-creep, invent APIs, skip tests, and "helpfully" refactor unrelated code. Every ticket below is designed against those failures:

- **One ticket = one PR = one session.** Under ~300 changed lines. Fresh context each time.
- **Interfaces are given, not invented.** Function signatures and file paths are in the ticket. The model fills in bodies.
- **Tests are named before code.** The ticket says which test file must exist and what it asserts.
- **A "do not touch" list.** Explicit files the model must not modify.
- **Acceptance criteria are checkable by you in minutes** without reading the code.
- **The Prompt block is copy-paste.** Paste it as the first message with `AGENTS.md` in the repo.

### Ticket template

```
ID / Title / Size (S ≤1h, M ≤3h, L ≤6h) / Depends on / Spec refs
Files: create / modify / DO NOT TOUCH
Interfaces: exact signatures
Tests: file + assertions
Acceptance: what you verify
Prompt: paste verbatim
```

### Universal prompt preamble (prepend to every Prompt)

```
Read AGENTS.md first and follow it exactly. Work only on the ticket below. Do not modify files outside the "Files" list. Do not add dependencies not named in the ticket. Write the tests named in the ticket before implementing. When done, run `bun test` and `bun run typecheck` and paste the output. If anything in the ticket is ambiguous, state your assumption in one line and proceed; do not ask questions.
```

---

# M0 — Demo Day (Sept 14) — **COMPLETE**

M0-01 … M0-07 are done and their tickets are retired; the work is in git history and in `core/biometrics/` and `site/`. `core/biometrics/{features,score,capture}.ts` and `site/` are the only pre-M1 files that carry forward. Nothing under M1 may patch pre-M0 server or extension code — there is none left in the tree.

> Note: M0-02's feature-vector spec was superseded only in *content*: seven globals, none of them count-based. The length is unchanged at `3n + 5` (n=6 → 23), which is what the M0 code and its test always produced. See docs/02 A-4.2, owned by M1-16.

---

# M1 — Foundation Rewrite

### M1-01 · Server skeleton: Hono + Drizzle + config · M · refs A-8, A-13
**Files:** create `server/src/app.ts`, `server/src/config.ts`, `server/src/db/{schema.ts,client.ts}`, `server/drizzle.config.ts`, `server/src/routes/health.ts`, tests. Remove `ENCRYPTION_KEY`, in-memory revocation, `credentials`, `enroll_tokens`.
**Spec:** `config.ts` loads env with Zod; **exits with a clear message if `JWT_SECRET` < 32 bytes**. `DATABASE_URL` selects `bun:sqlite` or `postgres`. `GET /healthz` → `{ok:true, db:'sqlite'|'postgres'}`.
**Tests:** config rejects missing secret; healthz 200 on both drivers (Postgres via `DATABASE_URL` in CI service).
**Prompt:** `Ticket M1-01. Replace the existing server entry with a Hono app… [paste Spec]. Add dependencies: hono, drizzle-orm, drizzle-kit, postgres, zod. Do not port old routes yet.`

### M1-02 · Schema and migrations · M · deps: M1-01 · refs A-9
All tables from A-9 in Drizzle with both dialects. `bun run db:migrate`. Test: migrate on fresh SQLite and Postgres; insert/select a user.

Column names settled in v1.2 and owned by this ticket: `biometric_profiles.script_len` (**not** `passphrase_len`), `biometric_profiles.script_commitments`, `users.key_version`, `users.consent_at`, `users.consent_policy_version`.

### M1-03 · `core/crypto/kdf.ts` — Argon2id + HKDF · M · refs A-2
```ts
export async function deriveMasterKey(kdfInput: Uint8Array, salt: Uint8Array, params?: ArgonParams): Promise<Uint8Array>; // 32B
export async function deriveSubkey(masterKey: Uint8Array, info: 'cypherkey/auth/v1' | 'cypherkey/wrap/v1' | 'cypherkey/phantom/v1'): Promise<Uint8Array>;
export function randomBytes(n: number): Uint8Array;
```
Use `@noble/hashes` (argon2id, hkdf). `kdfInput` is bytes, not a string, so it can carry the NUL-separated Strict input from M1-17 without a later widening. Tests: known-answer vectors (generate once with a reference implementation and commit them); different salts → different keys; subkeys differ by info.

### M1-04 · `core/crypto/aead.ts` — AES-256-GCM wrap/unwrap + item encryption · M · deps: M1-03
```ts
export async function wrapKey(key: Uint8Array, wrappingKey: Uint8Array): Promise<{ct: Uint8Array, nonce: Uint8Array}>;
export async function unwrapKey(wrapped: {ct, nonce}, wrappingKey: Uint8Array): Promise<Uint8Array>;
export async function encryptItem(plaintext: Uint8Array, vaultKey: Uint8Array, itemId: string): Promise<{ct, nonce}>; // aad = itemId
export async function decryptItem(...): Promise<Uint8Array>;
export function xor32(a: Uint8Array, b: Uint8Array): Uint8Array;
```
WebCrypto `AES-GCM`. Tests: roundtrip; tamper → throws; wrong aad → throws; nonce uniqueness across 1,000 calls.

### M1-05 · `core/crypto/device.ts` — Ed25519 device keys and request signing · M · deps: M1-03 · refs A-3
```ts
export async function generateDeviceKey(): Promise<{pub: Uint8Array, priv: Uint8Array}>;
export async function signRequest(priv, {nonce, ts, method, path, body}): Promise<string>; // base64url
export async function verifyRequest(pub, sig, {...}): Promise<boolean>;
```
Tests: roundtrip; altered body fails; altered path fails.

### M1-06 · `core/crypto/recovery.ts` — Recovery Kit · S · deps: M1-03, M1-04
32-char Crockford base32 code (160 bits) → HKDF → recovery wrap key. `generateRecoveryCode()`, `recoveryKeyFromCode(code)`, format/parse with checksum char. Tests: checksum catches single-char typos; case-insensitive.

**Length conflict, resolved in favour of entropy (M1-06).** "32 characters" and "160 bits" and "a checksum char" cannot all hold at once: 160 bits *is* 32 Crockford symbols, leaving no room for a check symbol inside 32. The code is therefore **33 characters — 32 data + 1 check** — and `03` X-2 step 3 is updated to match. The alternative, had display length mattered more, was 31 data symbols (155 bits) plus a check inside 32 characters; 160 bits was judged the property worth keeping. X-2's "re-enter 4 characters" is unaffected, and the code is grouped in fours.

Crockford's check is the secret read as a big-endian integer mod 37. Because 37 is prime and no single-symbol delta is divisible by it, this provably catches **every** single-symbol substitution and every adjacent transposition — both are tested exhaustively rather than sampled. HKDF, not Argon2id, derives the wrap key: the input is already 160 uniform random bits, not a passphrase.

### M1-06b · `core/crypto/encoding.ts` · S · deps: M1-05 · **done**
**Files:** create `core/crypto/encoding.ts`, `core/crypto/encoding.test.ts`; modify `core/crypto/device.ts` (replace its private helpers with imports). DO NOT TOUCH anything else.
**Interfaces:**
```ts
export function toBase64Url(bytes: Uint8Array): string;          // no padding, RFC 4648 §5
export function fromBase64Url(s: string): Uint8Array;            // throws on invalid chars or padding
export function utf8Encode(s: string): Uint8Array;
export function utf8Decode(b: Uint8Array): string;
export function concatBytes(...parts: Uint8Array[]): Uint8Array;
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean; // constant-time
```
**Tests:** roundtrip for lengths 0–70; known vector (bytes 0x3e 0x3f → `"Pj8"`); rejects `+` `/` `=` and whitespace; `equalBytes` false on length mismatch; `device.test.ts` still passes unchanged.
**Acceptance:** `grep -rn "base64" core/ | grep -v encoding` shows only imports.
**Corrections found while building it:** `equalBytes` is re-exported from `@noble/curves/abstract/utils`, not `@noble/hashes/utils`, which has no such export. `device.test.ts` had to be touched despite the DO NOT TOUCH list, because its `Buffer.from(..., 'base64')` cross-check otherwise fails the acceptance grep.

### M1-07 · `core/client/session.ts` — the client state machine · L · deps: M1-03..06 · refs A-5
Pure TS, no DOM: `signup()`, `login()`, `stepUp()`, `lock()`, `unlockOffline()`, with an injected `fetch` and `storage` interface. Holds `vaultKey` in memory; `lock()` zero-fills. Tests with a mocked server: full sequence from A-5 login flow.

### M1-08 · Server `/auth/salt`, `/auth/signup` · M · deps: M1-02, M1-05
Validate with Zod; store Argon2id(authHash) via `Bun.password`; generate `server_share`; store `consent_at` and `consent_policy_version` from the request; register device pub key; **return `serverShare` in the 201** (A-5 signup handshake). A second call registers `recoveryWrappedVaultKey`, which wraps the full `vaultKey`; enrollment is refused until it exists. Tests: duplicate username 409; salt fetch for unknown user returns a deterministic fake salt (prevents user enumeration) — HMAC(username, server secret).

### M1-09 · Server `/auth/login` with scoring and bands · L · deps: M1-08, M0-03 · refs A-4.4, A-5
Verify authHash → device sig → nonce/ts → score → band → tokens or stepUp. 500 ms floor. Score row written; feature vector **never** persisted (test asserts DB contains no vector). Lockout after 5 fails. Tests: pass/grey/fail/new-device/lockout/replayed nonce.

### M1-10 · Server `/enroll/*` · M · deps: M1-08 · refs A-4.3
Sample upload (requires enrollment-scoped token issued at signup), build at N samples, delete samples after build. Tests: builds at exactly N; samples table empty after; rejects vector whose length is not `3·script_len + 5`. The server derives `script_len` from the first sample and validates it against `getFeatureRanges` in `core/biometrics/features.ts`, which is the single definition of the layout (AGENTS). It also enforces a **minimum script length of 12**: `03` X-2 requires 12 resolved characters and phantoms only add tokens, and without a floor a 1-token script is a well-formed `3n + 5` vector that builds a profile scoring everything alike.

### M1-11 · Refresh tokens, logout, device list/revoke · M · deps: M1-09
Rotating refresh tokens hashed in DB; reuse of a rotated token revokes the family. Tests: rotation; reuse → all revoked.

### M1-12 · Server `/vault/changes` · M · deps: M1-09 · refs A-6
Cursor-based get; batch upsert with version check → 409 with server copy on conflict. Tests: two "devices" write same item; second gets 409 and server value.

### M1-13 · Server `/user/settings`, `/user/rhythm` · S · deps: M1-09
Settings PATCH requires a fresh step-up flag on the token for `biometricEnabled=false` or `pauseUntil`.

### M1-14 · Rate limiting + audit log middleware · M · deps: M1-09
Token bucket per IP (100/min) and per account (10 logins/min) in DB; `audit_log` writes for auth events; IPs stored as salted hash.

### M1-15 · Docker + compose + CI · M · deps: all M1
`Dockerfile` (bun, non-root), `docker-compose.yml` (server + volume; optional Postgres profile), GitHub Actions: typecheck, lint, `bun audit`, and **two test jobs** — one on SQLite with `DATABASE_URL` unset, one with a `postgres:16` **service container** and `DATABASE_URL` set to it.

**Postgres posture (decided):** Postgres is never installed in dev and never goes in our image. Local `bun test` runs SQLite only; every Postgres suite skips cleanly via `server/src/testing/postgres.ts` and prints one line saying so. CI is the only place both drivers run. Production reaches a managed Postgres over the network through `DATABASE_URL`. The compose Postgres profile is a self-host convenience, not our runtime. **Exit test for M1:** `scripts/e2e.ts` runs the full sequence from file 04, including the Phantom Keys acceptance cases from M1-17b.

### M1-16 · Phantom Keys: token capture and script canonicalization · M · deps: M0-02, M0-04 · refs A-14.1
**Files:** create `core/biometrics/script.ts`, `core/biometrics/script.test.ts`; modify `core/biometrics/features.ts` (+test), `core/biometrics/capture.ts` (+test). DO NOT TOUCH: server, site, crypto.
**Interfaces:**
```ts
export type Token = string; // one code point: printable ASCII, U+0008, U+007F, U+001B, or U+E000–U+E004
export function eventsToScript(events: KeyEvent[]): { script: string; resolved: string } | { error: 'unsupported_key' | 'unsupported_combo' | 'focus_lost' | 'malformed' };
export function scriptsEqual(a: string, b: string): boolean;   // constant-time
export function scriptLength(script: string): number;          // code-point count
```
**Changes:** `KeyEvent` gains `{ type: 'blur' }`. `startCapture` records Backspace/Delete/Escape (Escape with `preventDefault`), detects lone modifier taps (down/up with no other keydown in between) as tokens, marks Ctrl/Alt/Meta chords, listens for `blur`, and cancels on Tab/Enter-as-non-terminator/arrows/nav keys/`paste`/`drop`/`compositionstart`. `extractFeatures` treats every token as a key and the `backspace` error is removed. **Do not add a `backspaceCount` global** — the earlier instruction to keep it at weight 0 was wrong and is withdrawn: a count of Backspace tokens tells the server how many backspaces are in the script, which breaks A-14's guarantee that only the script *length* leaks. The vector stays at `3n + 5` with the seven globals M0 shipped, `n` = script token count (docs/02 A-4.2).
**Tests:** `script.test.ts`: (1) `p,a,s,s,s,s,⌫,⌫,w,0,r,d` → length 12, resolved `passw0rd`; (2) Shift-held `P` → single token `P`, no modifier token; (3) lone Ctrl tap → U+E001 token; (4) Ctrl+A → `unsupported_combo`; (5) ArrowLeft → `unsupported_key`; (6) blur mid-sample → `focus_lost`; (7) Escape → U+001B token; (8) `scriptsEqual` false between (1) and plain `passw0rd`.
**Prompt:**
```
Ticket M1-16. Implement docs/02 A-14.1 token rules in core/biometrics/script.ts and update capture.ts and features.ts as specified: [paste Interfaces, Changes]. Write script.test.ts with the eight cases first. Do not touch crypto or server.
```

### M1-17 · Phantom commitments and KDF input selection · M · deps: M1-16, M1-03 · refs A-14.2, A-16
**Files:** create `core/crypto/phantom.ts` (+test); modify `core/crypto/kdf.ts` (+test).
**Interfaces:**
```ts
export type Strictness = 'strict' | 'medium' | 'relaxed';
export function kdfInput(resolved: string, script: string, level: Strictness): Uint8Array; // resolved, or resolved||0x00||script for strict
export async function scriptCommitments(phantomKey: Uint8Array, script: string): Promise<Uint8Array[]>; // 16-byte HMAC-SHA256 per token
export function budget(level: Strictness, canonLen: number): { maxInsertions: number; maxMissing: number }; // per A-16 table
export function rhythmBands(level: Strictness): { pass: number; grey: number };                            // the other half of the same A-16 row
```
**Tests:** commitments differ per token, equal for repeated tokens, differ per key; `kdfInput` differs for strict vs medium on the same inputs; `budget` table (A-16, v1.2 — insertions and deletions are budgeted separately): (medium,10)={2,0}, (medium,25)={4,0}, (relaxed,10)={4,1}, (relaxed,25)={8,1}, (strict,*)={0,0}.

### M1-17b · Server: commitment storage, edit-distance check, aligned scoring · L · deps: M1-17, M1-09, M1-10 · refs A-14.3, A-4.4
**Files:** create `server/src/phantom/align.ts` (+test), modify `server/src/biometrics/score.ts` (+test), `server/src/routes/{enroll,login}.ts`, schema: `biometric_profiles.script_commitments BLOB`.
**Interfaces:**
```ts
export type Alignment = { distance: number; ops: Array<{ op: 'match'|'sub'|'ins'|'del'; canonIdx: number|null; loginIdx: number|null }> };
export function alignCommitments(canonical: Uint8Array[], login: Uint8Array[]): Alignment; // edit-distance path, O(n·m), n,m ≤ 128; report insertions/deletions/substitutions separately, never one symmetric number
export function score(profile: Profile, sample: FeatureVector, alignment?: Alignment): number; // ins → bridge (drop dwell, recompute spanning flight/digraph from retained neighbours); del → dwell and both touching pairs at 0.5 with half weight; sub keeps timing; globals recomputed from the aligned token set so both sides are 3·canonLen + 7
```
**Flow:** login → verify authHash → device sig → `alignCommitments` → `insertions > maxInsertions` **or** `deletions + substitutions > maxMissing` ⇒ 401 `phantom_mismatch` (counts toward lockout) → else aligned rhythm score → band. Enrollment stores canonical commitments with the profile; samples must be distance 0.
**Tests:** (1) identical → 0 ins / 0 del, ops all match; (2) one extra `x⌫` pair → 2 insertions, **passes** at Medium (`maxInsertions` = 2 at n=10); (3) login missing one canonical token → 1 deletion → 401 at Medium (`maxMissing` = 0) and the lockout counter increments; (3b) login with the resolved passphrase only, against a two-phantom canonical → 2 deletions → 401 at Medium **and** at Relaxed; (4) a 13-token login vs a 12-token profile scores within **0.02** *when the stray keystroke costs no extra wall-clock time* — measured in M1-17b, the deviation otherwise scales with how long the fumble took (~0.08 at +60 ms) and is not bounded by a constant, because bridging keeps that evidence on purpose; (4b) a deletion under Relaxed scores within **0.06**; (5) no commitment, token, or vector appears in logs (assert log capture).
**Acceptance:** e2e: enroll with 2 phantoms on Medium; login with one lone-Escape slip passes; login with resolved passphrase only (missing both phantoms) fails; wrong passphrase fails before alignment runs (timing-padded).

### M1-17c · Strictness setting endpoint and Strict re-key flow · M · deps: M1-17b, M1-13

**Added retroactively (A-17), to be tested when M3's TOTP lands:** a re-key performed while a TOTP factor is enrolled must leave that factor verifiable afterwards. The secret is encrypted under `stepUpKey = HKDF(authHash, …)` and the re-key changes `authHash`, so the client must send the old and the new value together and the server must re-wrap in the same transaction — or roll the whole change back. Until TOTP exists there is nothing to re-wrap and nothing to test; the requirement is recorded here so it is not discovered by an account that can no longer step up.
`PATCH /user/settings {strictness}` requires step-up flag; server updates thresholds. Client `session.changeStrictness(level)`: if crossing into/out of Strict, re-derive `masterKey`, re-wrap `vaultKey`, re-register `authHash`, re-send commitments, revoke other devices' cached keys (bump `key_version`). Tests: medium→relaxed touches no keys; medium→strict rotates and old authHash no longer works.

### M1-18 · Update the web demo for Phantom Keys · S · deps: M1-16
`site/demo.ts`: allow Backspace during enrollment; add a "Try Phantom Keys" toggle with the explanation copy from A-14; show token count vs character count ("12 keystrokes · 8 characters"). Keep client-only.

### M1-19 · Build pipeline and size budgets · M · deps: M1-15 · refs A-15
`bun build --compile` for the server, multi-stage distroless Dockerfile, `scripts/size-check.ts` with the A-15 budgets, CI step that fails on regression and posts sizes. Tests: the script itself has a unit test with a fixture over/under budget.

---

# M2 — Extension and Private Beta

Use **WXT** (MV3, Chrome + Firefox, React + TypeScript). One ticket per screen or subsystem.

### M2-00d · Reunite `core/client` with the server, and make the e2e prove it · M · deps: all M1 · **DONE**

**The gap.** `core/client/session.ts` was written in M1-07 against the pre-commitment wire format. M1-17b then made `commitments` a required field on `/auth/login` and `/enroll/sample`, and nothing forced the two back together. Driving the real session against the real server today:

```
session.signup → OK
session.login  → THREW: login failed with status 400
```

The shipped client library cannot log in to the server it ships with.

**Why M1 did not catch it.** `scripts/e2e.ts` has its own `call()` helper hitting `app.request` directly; it never imports `core/client`. The M1 exit test therefore proved the *routes* work and said nothing about the client. That is the underlying bug, and it is worth more than the drift it hid.

**Files:** modify `core/client/session.ts` (+test), `scripts/e2e.ts`; create `core/client/enroll.ts` (+test), `core/client/sync.ts` (+test).

**Interfaces** — additions, alongside the existing `Session` surface recorded below:
```ts
// core/client/session.ts — login and step-up must carry the script
export type LoginInput = Credential & {
  username: string;
  featureVector: number[];
  commitments: string[];      // base64url, one per script token (A-14.2)
};
export type StepUpInput = { method: 'retype'; featureVector: number[]; commitments: string[] };

// core/client/enroll.ts — no client exists for /enroll/* at all
export function createEnroller(deps: EnrollDeps): {
  status(): Promise<{ required: number; submitted: number; remaining: number; built: boolean }>;
  sample(input: { featureVector: number[]; commitments: string[] }): Promise<{ samplesRemaining: number }>;
  build(): Promise<{ built: true; scriptLen: number; sampleCount: number }>;
};

// core/client/sync.ts — no client exists for /vault/changes either
export function createSync(deps: SyncDeps): {
  pull(since: number): Promise<{ items: VaultItemWire[]; cursor: number }>;
  push(items: VaultItemWire[]): Promise<{ cursor: number; applied: Applied[]; conflicts: Conflict[] }>;
};
```

**What it actually found.** The known `commitments` drift was one of five defects; the other four were invisible until the e2e drove the real client:

1. `/auth/login` was missing `commitments` — the known one.
2. `/auth/step-up` was sent `{ method, proof, username }`; the server requires `{ username, authHash, method: 'retype', featureVector, commitments }`. The client's idea of step-up was an opaque proof string, which the server has never accepted.
3. `signup` discarded the `enrollmentToken` from the 201, so enrollment was unreachable from the client library at all.
4. **No second device could ever be provisioned.** Only `signup` generated a device key, so a fresh install could not sign anything, and the server registers a device from the public key in the signature header at step-up. `login` now mints a provisional key when the install has none and persists it once step-up clears.
5. **A wrong passphrase crashed the client.** It derives a different `wrapKey`, so unwrapping the stored device key threw `DecryptionError` out of `login` instead of returning `invalid_credentials` — an unhandled exception on the single most ordinary user error there is. `loadDevice` now treats an unwrap failure as "wrong passphrase", signs nothing, and lets the server answer 401.

Items 4 and 5 were both reached only because step 11 and step 13 of the e2e now run through the client. Neither had a route bug; both were client bugs that no route test could see.

**Also added:** `session.refresh()`, `session.logout()`, `session.tokens()` and `session.authed()` — the last being the device-signed transport that `createEnroller` and `createSync` consume, so neither holds key material of its own.

**M2-00d.1, done in the same pass — commitments cost a second Argon2id.** The interface above asked the caller for `commitments`, but computing them needs `phantomKey`, which needs `masterKey`, which the session derives internally and discards. Every caller therefore had to run Argon2id a second time at m=64 MiB purely to commit its own script — and needed the salt to do it, so the e2e was reaching into session storage to get one.

Fixed by making the session derive all three A-2 branches from its single Argon2id pass and hold `phantomKey` for the life of the unlock:

- `Credential` is now `{ resolved, script, strictness }` rather than `{ kdfInput }`. The session builds the KDF input itself, which it must anyway to honour A-16.
- `LoginInput` and `StepUpInput` no longer carry `commitments`; `StepUpInput` carries the retyped `script`, since a retype may legitimately differ from the first attempt.
- New `session.commitmentsFor(script)` serves enrollment, which is not a login and had no other way to get them.
- A grey login now holds the phantom branch alongside the wrap key, so the retype is committed without re-deriving.
- `changeStrictness` re-keys the held branch, which it previously discarded — a stale `phantomKey` after a Strict crossing would have produced commitments the server rejects.

Pinned by a `spyOn(kdf, 'deriveMasterKey')` test asserting exactly one call per unlock and zero per commitment, plus an absence test that `phantomKey` never reaches storage.

**Acceptance (this is the point of the ticket).** `scripts/e2e.ts` is rewritten to drive *every* step through `core/client` — `session.ts` for signup/login/step-up/refresh/logout, `enroll.ts` for enrollment, `sync.ts` for the vault legs. No `app.request` call survives outside the injected `fetch`. From then on any drift between client and server fails CI on the next push instead of surfacing a milestone later.

### M2-00e · Server support for Backup Code step-up · M · deps: M1-13a · **DONE**

**Why.** M2-07 says step-up with backup codes. The server accepts `retype` only, and `step_up_factors` is a table no route touches, so M2-07 cannot be built until this exists.

**Naming, and it is load-bearing.** These ten one-time codes are **Backup Codes**, everywhere — route, table, response field, UI string, doc. **"Recovery" is reserved for the Recovery Kit**, which is a different object with a different job and a different failure mode: the Kit opens the vault, a Backup Code opens a session. The two were called the same thing in the original draft and that is exactly how the mistake below happened.

**A correction I owe.** The M1-13a commit said a recovery code "cannot be verified server-side without breaking zero-knowledge". That conflated the two objects the rename now separates. The **Recovery Kit** (X-5, 33 Crockford characters) derives `recoveryKey` and unwraps the vault — the server must never hold anything that helps guess it. **Backup Codes** (X-3) derive nothing and unwrap nothing; they only prove "it is me" to the server. Verifying those server-side is right and costs no confidentiality: the vault still needs the passphrase, so a stolen code buys a session and no plaintext.

**Files:** create `server/src/routes/backup-codes.ts` (+test); modify `server/src/routes/stepup.ts` (+test), `server/src/routes/auth.ts` (signup returns the first set), `server/src/db/schema/{sqlite,pg}.ts`, `docs/02` A-9 and A-10.

**Schema.** A new table rather than `step_up_factors`:
```
backup_codes | id, user_id, code_hash (unique), used_at, created_at
```
`step_up_factors.secret_enc` is the wrong home: a one-time code needs a one-way hash, not a reversible secret. **A-17 now settles what that column means for the factors that do need one** — passkeys plaintext, TOTP encrypted under `stepUpKey = HKDF(authHash, …)`, implemented in M3. Backup Codes stay out of it entirely.

**Interfaces / wire:**
```
POST /auth/signup          → 201 now also returns { backupCodes: string[] }   (ten, shown once)
POST /user/backup-codes    → regenerate; invalidates every previous code, returns ten new.
                             Access token + device signature + the passphrase in the same
                             request (A-17), not a step-up flag minted earlier.
GET  /user/backup-codes    → { remaining: number }   — never the codes themselves
POST /auth/step-up         → gains { method: 'backup_code', proof: string }
```

**Codes.** Ten per set, ten Crockford base32 symbols each (50 bits), formatted `XXXXX-XXXXX`. Server-generated, because they are not key material: the server already sees `authHash` at signup, and a malicious operator gains nothing here that A-11 does not already grant it — the vault still needs the passphrase-derived `wrapKey`. Stored as `base64url(sha256(normalized))`, the same treatment as refresh tokens and for the same reason: these are high-entropy secrets the server generated, so a fast hash is correct and Argon2id is for low-entropy human input. Verification normalizes case and strips hyphens before lookup.

**Lockout — this ticket must also fix an existing hole.** A failed step-up currently returns 401 and does **not** call `recordFailure`, so step-up attempts are bounded only by the per-account rate limit (ten a minute). That is tolerable for a rhythm retype and not for a bearer secret. Failed `backup_code` attempts must count toward lockout, and the retype path should count too.

**Tests:** signup returns ten distinct codes and stores ten hashes, never a code in the clear; a valid code clears step-up and issues a token carrying `stepUpAt`; the same code fails the second time (`used_at` set); an unknown code fails; a code belonging to another account fails; failures increment the lockout counter and five of them lock; regeneration invalidates the whole previous set; `GET` returns a count and no code; the response and every table are asserted free of any code after storage.

**Acceptance:** enrol, force a grey login, clear it with a Backup Code rather than a retype, and confirm the second use of that code is refused. No response body or table row anywhere contains a code in the clear.

**As built.** 23 tests in `backup-codes.test.ts`, covering all of the above.

- One extra file was needed: **`server/src/auth/lockout.ts`**. `recordFailure` was private to `login.ts`, and both doors have to count against the same budget — duplicating the doubling policy across two routes is how they drift apart. `login.ts` and `stepup.ts` now share it.
- The lockout test initially read 4 failures instead of 5: with a frozen clock, the A-8 account bucket (ten a minute) refuses the tenth request before lockout is reached. The test now advances the clock between attempts, which is also the realistic shape of the attack. Worth remembering that **the rate limit hides lockout bugs in any test with a frozen clock.**
- The client cannot yet drive `backup_code` — `core/client`'s `StepUpInput` is retype-only — so the e2e does not cover this path. That is M2-07's job and should be part of it.
- Corrected a stale claim in `stepup.ts`'s header comment, which still said a code "cannot be checked server-side without breaking zero-knowledge". Same conflation this ticket exists to undo.

### M2-00f · Server-authenticated recovery · L · deps: M2-00e · **DONE**

**Confirmed gap, both halves.** There is no `recoveryAuthHash` anywhere in the codebase: `POST /auth/recovery-key` stores `recoveryWrappedVaultKey` and nothing else, so nothing proves possession of the Kit. And there is no `POST /auth/recover` — `03` X-5 describes the flow and no route implements it. Recovery today is a paragraph, not a feature.

That matters more than a missing endpoint. `recoveryWrappedVaultKey` is the vault key wrapped under a key derived from the Kit. An unauthenticated recovery endpoint would hand that blob to anyone who could name a username, turning the server into an oracle that distributes the encrypted vault key on request. Verifying the Kit *before releasing anything* is the whole point.

**Files:** create `server/src/routes/recover.ts` (+test); modify `server/src/routes/auth.ts` (register the auth hash), `server/src/db/schema/{sqlite,pg}.ts`, `core/crypto/recovery.ts` (+test), `core/client/session.ts` (+test), `docs/02` A-2/A-9/A-10.

**Derivation.** A second branch off the Kit, so the value that authenticates is not the value that unwraps:
```ts
recoveryKey      = HKDF(recoverySecret, "cypherkey/recovery/v1")        // existing; unwraps the vault
recoveryAuthHash = HKDF(recoveryKey,    "cypherkey/recovery-auth/v1")   // new; proves possession
```
Chained rather than a sibling of `recoveryKey` purely to reuse the tested `recoveryKeyFromCode()`; HKDF is one-way either way, so the stored verifier reveals nothing about the wrap key. The server stores `Argon2id(recoveryAuthHash)` in a new `users.recovery_auth_hash`, exactly as it stores `Argon2id(authHash)`.

**Registration.** `POST /auth/recovery-key` gains `recoveryAuthHash` in the same one-shot call that registers the blob. It stays one-shot: both land together or neither does, so an account can never hold a blob nobody can prove title to.

**Two calls, and the first one writes nothing.**
```
POST /auth/recover/begin   { username, recoveryAuthHash }
                           → verifies, then returns { recoveryWrappedVaultKey, serverShare }
                           → READ-ONLY. Touches no factor, no device, no key, no profile.

POST /auth/recover         { username, recoveryAuthHash, newAuthHash, newUserSalt,
                             newWrappedVaultKey, devicePub, deviceName, devicePlatform }
                           → verifies again, then does everything below in ONE transaction
```
The split is forced, not convenient: the client cannot compute `newWrappedVaultKey` until it has unwrapped `vaultKey`, and it cannot unwrap `vaultKey` until it has the blob. Doing it in one call would mean the server re-wrapping, which it cannot do. Doing it in two *unverified* calls, or letting the first one mutate, is what the requirement forbids — so `begin` demands the same proof, counts toward the same lockout, and changes nothing.

**The single transaction.** All of it commits or none of it does:
1. delete every TOTP factor (A-17: their secrets were encrypted under a key derived from the passphrase that has just been lost, so they are unreachable and must not be left behind to lock the account out);
2. revoke every device and every refresh token;
3. register the presenting device;
4. write the new `authHash`, `userSalt`, `argonParams` and `wrappedVaultKey`, and bump `key_version`;
5. delete the biometric profile and any enrollment samples — X-5 requires a fresh enrolment;
6. leave **Backup Codes untouched**: they are `sha256` hashes and owe nothing to the passphrase.

Returns `{ userId, serverShare, enrollmentToken }`. `vaultKey` itself never changes, so the vault is not re-encrypted.

**Hardening, matching `/auth/login` exactly.** The 500 ms timing floor on every path, including an unknown username; failures increment the same lockout counter with the same five-attempt threshold; the per-account rate-limit bucket applies; every rejection answers identically so a caller cannot distinguish an unknown user from a wrong Kit.

**Tests:** a correct Kit recovers and the new passphrase logs in; the old passphrase does not; `begin` with a wrong `recoveryAuthHash` is 401 and returns no blob; `begin` mutates nothing (row-for-row comparison before and after); a wrong Kit increments lockout and five lock the account; an enrolled TOTP factor is gone afterwards and Backup Codes still work; every device is revoked and the presenting one is registered; the profile is gone and `/enroll/status` says so; a failure mid-transaction leaves the account exactly as it was; no response or table contains the Kit, `recoveryAuthHash`, or a decrypted key.

**As built.** 16 tests in `recover.test.ts`, plus 6 client tests and three new e2e steps (19–21), which now drive real recovery through `core/client` instead of reading the blob out of the users table.

- **A trap found on the way: Drizzle's sqlite `transaction()` does not roll back an async callback.** `bun:sqlite` is synchronous, so the transaction returns before the promise settles and the writes escape transactional control. A throw rolled back *nothing* — measured, and it would have passed every test while quietly defeating this ticket's central requirement. The route uses a synchronous body with `.run()` on sqlite and the awaited one on Postgres, and `recover.test.ts` forces a mid-transaction primary-key collision to prove the rollback. Recorded in A-9 so the next multi-write route does not rediscover it.
- A failed transaction returns `recovery_failed` (500) rather than leaking a driver error, and does **not** count against lockout: the Kit was correct, something else broke.
- Every other route test had to gain `recoveryAuthHash`, since `/auth/recovery-key` now requires it — 33 tests failed until they did, which is the schema change being load-bearing rather than cosmetic.

**Decided (2026-09-05): recovery issues a new Kit and retires the used one.** The client wraps the unchanged `vaultKey` under a fresh Kit and sends `newRecoveryWrappedVaultKey` + `newRecoveryAuthHash`; the same transaction that writes the new passphrase replaces the Kit. `session.recover()` returns the new code so the screen can show it once.

The subtlety worth keeping: **retiring the old Kit is inside the transaction.** If it were not, a recovery that failed partway would leave the account with no working Kit at all — a failure mode strictly worse than the one this change fixes. `recover.test.ts` forces a rollback and asserts the *original* Kit still authenticates. The old one still unwraps the vault, since `vaultKey` is unchanged. Regenerating is better hygiene — the Kit was just typed into a context that may be why recovery was needed — but it costs a "save this new Kit" step at the worst possible moment. Left as-is unless you say otherwise.

### M2-00g · Learn from a verified step-up · M · deps: M1-09 · **approved, mechanism revised**

An earlier draft of this ticket proposed a "catch-up" adaptation after N consecutive passes in `[0.62, 0.70)`. **Measurement killed it.** With realistic per-login variation, a drifting user's samples straddle 0.70, so ordinary A-4.5 adaptation already pulls the profile along: a user 10% slower recovers fully in a median of 7 logins, unaided. The proposed catch-up fired **zero times in 60 logins at every α from 0.05 to 0.5**, because the same variation that rescues the user also breaks the consecutive streak. Lowering N enough to make it fire would make it fire for a borderline attacker too. The mechanism was solving a problem that mostly does not exist.

The real trap is below the pass band. A user 14% slower scores 0.572, never produces a sample over 0.70, recovers **0% of the time**, and is sent to step-up on every single login — permanently, because A-4.5 forbids learning from grey. See the table in docs/02 A-4.5.

**What to build instead.** Adapt after a **grey attempt whose step-up succeeded**. A completed passkey or TOTP challenge is stronger evidence of identity than a bare 0.70 score, and it is currently the one verified event the profile refuses to learn from. This is also attacker-safe in a way the catch-up was not: an attacker sitting in the grey band cannot complete the step-up, so they can never trigger it, whereas the catch-up asked only for repetition.

**Parameters.** α = 0.1, the same as ordinary adaptation — a step-up is at least as trustworthy as a 0.70 pass, so there is no reason to discount it. The existing once-per-10-minutes cap and the exact-script-match requirement both still apply. **This ticket blocks on step-up actually existing (M3 passkey/TOTP);** until then a grey user's only recovery is the Recovery Kit.

**Also in scope, as correctness rather than as a drift fix:** EMA the variance with a floor so `stds` can widen from real logins instead of being frozen at its one-sitting enrolment value. Measured, this is worth little by itself (0.717 → 0.724 for a stuck user, and it costs the owner a little), so it must not be sold as the fix for drift.

**Tests:** a user 14% slower who completes step-up is tracked back into the pass band within X logins; a grey attempt with a *failed* or absent step-up never adapts; a fail never adapts; the 10-minute cap holds; variance widens toward observed spread and never below the floor.

**Do not, in any case, ask users to type deliberately slowly or quickly during enrolment** — measured harmful, see docs/02 A-4.5.

### M2-00h · Capture without a DOM · M · deps: M1-16 · **DONE**

`startCapture(input: HTMLInputElement, light: HTMLElement)` is DOM-bound and throws without a visible Rhythm Light element. A terminal has neither, and M4's CLI ticket walks straight into it; mobile and desktop interfaces will too.

AGENTS already anticipates the split — "no DOM imports except `core/biometrics/capture.ts`" — but there is no non-DOM path today.

**The division that must hold.** `core` owns the `KeyEvent` contract, the A-14.1 tokenizer, the feature layout and the *rule* that capture requires a visible consent indicator. Each platform supplies an adapter that proves it has one: a visible element in the browser, a rendered indicator line in a TTY, the platform equivalent elsewhere. The rule is not that a DOM node exists; it is that the person can see the light. X-1 says a service that hides the light gets no data, and that has to survive the move off the DOM rather than being quietly dropped as untestable.

**Files:** create `core/biometrics/capture-contract.ts` (the adapter interface plus a `RhythmLight` proof type) and a test; refactor `core/biometrics/capture.ts` into the DOM adapter behind it. No behaviour change in the browser.

**As built.**

- **The visibility check happens before a single listener is attached.** A platform that hides its indicator never sees an event, rather than seeing them and discarding them afterwards — the second version has the timings in memory at some point, and this one never does.
- **`RhythmIndicator` has exactly two methods, and a test pins that.** Anything richer invites an adapter to report "visible" from configuration rather than from the world, which is the failure X-1 exists to prevent. There is no `headless` flag and no way to start capture without an indicator.
- **Which keys pulse is platform knowledge, not contract knowledge.** A-14.1 records a modifier's down/up pair, but a lone Shift is not a keystroke anyone expects to see pulse — and only the adapter knows what its platform calls Shift. `onPulse` is therefore separate from `onEvent`.
- **`isLightVisible` is exported and delegated to rather than reimplemented.** What "visible" means is the one question X-1 turns on, and two answers to it would be one too many.

**Deliberately not done: `startCapture` is not yet collapsed onto `startCaptureWith`.** Rewriting the most security-sensitive module in the same change that introduces the contract it would sit on is how a subtle regression gets in. Until it happens there are two capture paths, and `capture-dom.test.ts` asserts they produce the same events for the same typing — because if they ever disagreed about what a keystroke is, an account enrolled through one would fail to unlock through the other and nothing else would notice. Collapsing them is a small follow-up with that test already in place.

### M3-xx · Per-keyboard profiles, and what "identify the keyboard" can honestly mean · M · **researched, see below**

Answering directly: **a browser cannot identify a keyboard**, and the parts that look like they can should not be used as a security signal.

- **WebHID / WebUSB** can read a vendor and product id, but only behind an explicit per-device permission prompt, only in Chromium, and a laptop's built-in keyboard does not necessarily enumerate at all. Asking for device-enumeration permission on an unlock screen is also the opposite of the posture in A-12.
- **`navigator.keyboard.getLayoutMap()`** reports the *layout* — which character each physical key produces — not the device. Chromium only. It cannot distinguish a mechanical board from a laptop board on the same layout. *(API surface and availability to be confirmed against current documentation before implementation; it could not be tested in the build environment.)*
- **Nothing exposes switch type, travel or actuation.** Those are the properties that actually change typing rhythm.

**And anything the client reports about itself is attacker-controlled.** A device signature is Ed25519 and cannot be forged; a claimed keyboard id is a string in a JSON body. Keyboard identity may therefore inform *which profile to score against* — a usability decision — and must never be part of *whether to admit* — a security decision. That line should be explicit wherever this is built.

**Decision (2026-09-04): layer 1 only — per device.** Rhythm clustering within a single device is not being built; a user who swaps between a laptop keyboard and an external mechanical board on the same machine keeps one profile for now. Revisit only if real usage shows those users sitting in the grey band.

**What does work, and needs no new signal.** Two layers:

1. **Per device.** `devices` already carries an unforgeable Ed25519 identity, so "laptop versus desktop" is solved by keying the profile on `device_id`. This is the M3 per-device-profiles item already in the roadmap and it needs no keyboard detection whatsoever.
2. **Per cluster, within a device.** The unhandled case is the real one: the same laptop, sometimes with a mechanical keyboard plugged in. Detect it from the rhythm itself. If a user's accepted samples separate into two stable clusters, hold a profile per cluster and score against the nearest, admitting on the best match. A new cluster may only be created behind a step-up, exactly as a new device is, so it cannot become a way to widen the profile by typing differently.

**A free signal we already collect.** Every event carries `KeyboardEvent.code` since the M1-18 follow-up. If the same passphrase suddenly arrives via different codes, the *layout* changed — which changes rhythm far more than switch type does. Worth storing as a fingerprint of the enrolled layout and using to explain a rejection ("this looks like a different keyboard layout") rather than to grant anything.

### The client surface as it actually is

Verified against the source on 2026-09-05, after M2-00d, M2-00d.1 and M2-00f. Every M2 ticket must be written against these signatures; where a ticket needs something absent here, the ticket has to create it.

```ts
// core/client/session.ts
createSession(deps: SessionDeps): Session
type Credential = { resolved: string; script: string; strictness: Strictness };
  // NOT kdfInput bytes: the session derives authKey, wrapKey AND phantomKey from one
  // Argon2id pass, because asking a caller for commitments meant a second pass at 64 MiB.

type Session = {
  state(): SessionState;                      // 'locked' | 'unlocked' | 'step-up-required'
  signup(input: SignupInput): Promise<SignupResult>;   // -> { userId, recoveryCode, enrollmentToken }
  login(input: LoginInput): Promise<LoginResult>;      // Credential & { username, featureVector }
  stepUp(input: StepUpInput): Promise<LoginResult>;    // { method:'retype', script, featureVector }
  recover(input: RecoverInput): Promise<RecoverResult>; // -> { userId, enrollmentToken, recoveryCode }
  tokens(): { accessToken: string; refreshToken: string } | null;
  refresh(): Promise<boolean>;
  logout(): Promise<boolean>;
  authed(): AuthedRequest;                    // device-signed transport for the two below
  commitmentsFor(script: string): Promise<string[]>;   // uses the held phantomKey
  unlockOffline(input: Credential): Promise<boolean>;
  changeStrictness(input: StrictnessChange): Promise<{ keyVersion: number } | { error: string }>;
  lock(): void; touch(): void; checkIdle(): void;
  vaultKey(): Uint8Array;                     // throws while locked
};

// core/client/enroll.ts - createEnroller({ request: session.authed(), token })
type Enroller = {
  status(): Promise<{ required; submitted; remaining; built }>;
  sample(input: { featureVector: number[]; commitments: string[] }): Promise<{ samplesRemaining }>;
  build(): Promise<{ built: true; scriptLen: number; sampleCount: number }>;
};

// core/client/sync.ts - createSync({ request: session.authed(), token })
type Sync = {
  pull(since: number): Promise<{ items: VaultItemWire[]; cursor: number }>;
  push(items: VaultItemWire[]): Promise<{ cursor; applied: Applied[]; conflicts: Conflict[] }>;
};      // a 409 is a PARTIAL SUCCESS, not an error: clean items in the batch still applied

// core/biometrics/capture.ts
startCapture(
  input: HTMLInputElement,
  light: HTMLElement,
  opts?: { onPulse?: () => void; onCancel?: (reason: ScriptError) => void },
): { stop(): KeyEvent[]; cancel(): void }      // throws 'RhythmLightNotVisible'
  // DOM-bound. M2-00h introduces the adapter that CLI and mobile need.

// core/biometrics/script.ts
eventsToScript(events: KeyEvent[]): { script: string; resolved: string } | { error: ScriptError }
eventsToTokens - scriptsEqual (constant-time) - scriptLength (code points) - resolveScript
BACKSPACE '\u0008' - DELETE '\u007F' - ESCAPE '\u001B' - MODIFIER_TOKENS '\uE000'-'\uE004'

// core/biometrics/features.ts / score.ts
extractFeatures(events: KeyEvent[], expectedLen: number): FeatureVector | FeatureExtractionError
getFeatureRanges(len)                          // vector length is 3n + 5
buildProfile - score - band - adapt

// core/crypto/phantom.ts
kdfInput(resolved, script, level) - scriptCommitments(phantomKey, script)
budget(level, canonLen): { maxInsertions; maxMissing } - rhythmBands(level): { pass; grey }

// core/crypto/recovery.ts
generateRecoveryCode(): string                 // 33 chars: 32 data + 1 check symbol
parseRecoveryCode - recoveryKeyFromCode - formatRecoveryCode
recoveryAuthHashFromKey(recoveryKey)           // the verifier the server stores (M2-00f)
```

### Corrections from what M1 actually built

**Absorbed into the ticket bodies below on 2026-09-05.** They were a separate list, which is a second source of truth waiting to drift from the first; each correction now lives in the ticket it constrains.

| ID | Title | Size | Notes |
|---|---|---|---|
| M2-01 | WXT scaffold, popup/options/background/content scripts, Tailwind, storage abstraction implementing `core/client` storage interface | M | Argon2/WASM requirements below |

**M2-01 additional spec (Argon2 via `hash-wasm`, decided in M1-03):**
1. The manifest's `content_security_policy.extension_pages` must include `'wasm-unsafe-eval'`, or the WASM module will not instantiate under MV3.
2. The KDF runs in a **Web Worker**, never on the popup main thread — a ~175 ms hash on the main thread janks the unlock screen and blocks the Rhythm Light's per-keystroke pulse.
3. Fetch and compile the Argon2 module **when the popup opens**, in parallel with passphrase entry, not lazily on submit. The module is 11.6 KB gzipped; compiling it during typing makes the cost at submit the hash alone.
| M2-02 | `<RhythmLight/>` React component wrapping `startCapture`; pulse, bands, tooltip, ARIA | M | X-1 |
| M2-03 | Onboarding: passphrase + zxcvbn + generator | M | X-2 |
| M2-04 | Recovery Kit screen with "type 4 chars back" confirmation; printable view | M | X-2, M1-06 · printed Kit must carry the authenticator-app line, below |
| M2-05 | Enrollment screen: 8 samples, ring, backspace retry | M | |
| M2-06 | In-app Party Trick screen (post-enrollment, one-time) | S | X-7 |
| M2-07 | Unlock screen: login flow, bands, grey retype, step-up with Backup Codes | L | X-3 · needs M2-00e |
| M2-08 | Vault list, fuzzy search, item view, add/edit login + note | L | X-6 |
| M2-09 | Encrypted local cache (IndexedDB) + sync engine + offline queue | L | A-6, A-7 |
| M2-10 | Content script: field detection, domain-bound autofill, inline icon, punycode warning | L | X-6 — highest bug risk; budget for two passes |
| M2-11 | Generator (random + passphrase) with one-click fill | S | |
| M2-12 | Idle lock, lock on close, memory zeroing | S | |
| M2-13 | Import Bitwarden JSON + Chrome CSV | M | |
| M2-14 | Settings: devices list/revoke, biometric toggle, Pause (step-up gated), **Strictness slider (Strict · Medium · Relaxed) with the Strict re-key warning** | M | X-4, A-16 |
| M2-15 | "Not your rhythm" email (server, Resend) | S | X-3 |
| M2-16 | Hosted deploy: Cloud Run + Cloud SQL + secrets + status page | M | file 07; you do the console work |
| M2-17 | Beta feedback link + in-extension bug report (opens GitHub issue template) | S | |

## M2 ticket bodies

Written 2026-09-05 against the verified client surface above. Sequence: **M2-01 → M2-02 → M2-03 → M2-04 → M2-05 → M2-07 → M2-08 → M2-09 → M2-10** is the critical path; M2-06, M2-11, M2-12, M2-13, M2-17 can land any time after their dependency; M2-14 carries a server change; M2-15 and M2-16 are independent.

**Dependencies needing approval before use.** The M1 allowance covered hono, drizzle, postgres, zod, @noble/*, hash-wasm, happy-dom, biome. Everything below is new and must be cleared with its gzipped size first, per the standing rule: `wxt`, `react` + `react-dom`, `tailwindcss` (M2-01); `zxcvbn-ts` (M2-03); `fuse.js` (M2-08); `idb` (M2-09); `tldts` (M2-10); `resend` (M2-15). Where a small hand-rolled version would do, the ticket says so.

---

### M2-00i · The Recovery Kit must be replaceable · M · deps: M2-00f · **DONE**

**The gap, found by asking whether four small decisions were really one.** Kit confirmation was client-side state in `App.tsx` and the server never learned whether anything was saved. Enrollment gates on the Kit being *registered*, but the client does that automatically during signup, so it proves nothing about the human.

That leaves a **closed loop with no exit**: `/auth/recovery-key` is one-shot (409 if registered), so the only way to obtain a Kit is a recovery — which requires the Kit you do not have. Two entirely ordinary events land a user in it:

1. **Signup**, popup closed before confirming. The account works and the passphrase logs in, so nothing looks wrong. The user is one forgotten passphrase from a sealed vault and has no way to know.
2. **After a recovery**, popup closed before confirming — and this one is worse, because M2-00f retires the old Kit *inside* the transaction. That was the right call for atomicity, but it means there is an interval where the old Kit is dead and the new one exists only on screen.

**Files:** modify `server/src/routes/recover.ts` (+test), `core/client/session.ts`, `scripts/e2e.ts`, `docs/02` A-1/A-10.

**What was built.** `POST /user/recovery-kit` replaces the Kit for anyone who knows the passphrase — A-17 re-auth, so the passphrase travels in that request rather than resting on a session token an unlocked popup already carries. `session.rotateRecoveryKit(credential)` drives it and returns the new code to show once, reusing M2-04's screen. Failures count toward lockout.

**A second gap found while testing the flow end to end:** `/auth/recover` issued no session tokens, so a recovered session could not make a single authenticated request — including the rotation that rescues it. It now issues a session, which is right on its own merits: the Kit was just proved and the device just registered, and a forced re-login would land on a login with no profile to score against, since the transaction deleted it.

**Tests:** rotation retires the old Kit and the new one recovers; the passphrase is required and a session token alone is refused; a wrong passphrase counts toward lockout and moves nothing; repeated rotation retires each previous Kit; and the motivating scenario in full — recover, discard the issued Kit, re-enrol, log in with the new passphrase, rotate, and recover again with the rotated Kit. The e2e drives the same path through `core/client` as step 22.

**The more valuable half is the principle this exposed**, now A-1 principle 7: an artefact that leaves the system carries its own context and is always replaceable. The four decisions from M2-04 are derivations of it, not separate rulings.

### M2-01 · Extension scaffold and the storage adapter · M · deps: M2-00d · **DONE**

**Why.** Everything else in M2 is a screen inside this shell. It also has to prove the thing most likely to be wrong late: that Argon2id at m=64 MiB runs acceptably inside an MV3 popup.

**Files:** create `extension/` (WXT config, manifest, `entrypoints/{popup,options,background,content}`), `extension/src/storage.ts` (+test), `extension/src/kdf-worker.ts` (+test), `extension/src/session.ts` (+test).

**The Argon2 requirements, decided in M1-03 and non-negotiable:**
1. `content_security_policy.extension_pages` must include `'wasm-unsafe-eval'`, or the module will not instantiate under MV3.
2. The KDF runs in a **Web Worker**, never the popup main thread. A ~175 ms hash on the main thread janks the unlock screen and stalls the Rhythm Light's per-keystroke pulse — the one piece of UI that must never stutter, because its whole job is to show that capture is live.
3. Fetch and compile the module **when the popup opens**, in parallel with passphrase entry, not lazily on submit. It is 11.6 KB gzipped; compiling during typing leaves only the hash itself to pay for at submit.

**Interfaces.** `storage.ts` implements `SessionStorage` from `core/client` over `chrome.storage.local`:
```ts
export function extensionStorage(): SessionStorage;   // get/set/remove of strings
```
Only what A-7 permits may persist: the user salt, the device id and the wrapped device private key, and the wrapped offline vault blob. **Never** a vault key, wrap key, phantom key, passphrase, script or feature vector.

**Tests:** the storage adapter round-trips and `remove` really removes; a full `createSession` signup drives through it against a mocked `fetch`; the worker returns the same bytes as a direct `deriveMasterKey` for a known vector; the manifest contains `wasm-unsafe-eval`; an absence test that after signup, `chrome.storage.local` holds only the five permitted keys.

**Acceptance:** load unpacked in Chrome, sign up against a local server, and see the popup stay responsive throughout the hash. Measure and record the popup-open-to-unlock time; it is the number M2-07 is judged against.

**As built.**

- One file outside the list was required and changed: **`core/client/session.ts`**. It imported `deriveMasterKey` directly, so there was no seam to move the KDF off the main thread and requirement 2 was unreachable. `SessionDeps` now takes an optional `deriveKey`, matching how `fetch`, `storage` and `now` are already injected; it defaults to the direct call, so the server, the e2e and every existing test are untouched.
- `workerKdf` correlates requests **by id, not arrival order**. Two derivations can be in flight at once — an unlock racing a background refresh — and resolving in order would hand one caller the other's key. That is a silent wrong-key bug, not a visible failure, so there is a test that replies out of order deliberately.
- **A dependency conflict worth remembering:** `@wxt-dev/module-react` pulls `@vitejs/plugin-react`, whose v5+ requires Vite 8, while the site is on Vite 6. Rather than force a Vite major on working code, `@vitejs/plugin-react` is pinned to `^4` via a `package.json` override. Revisit when the site moves to Vite 8.
- **CI builds the extension.** The CSP that lets Argon2 instantiate under MV3 lives in the *generated* manifest, which no unit test can see; a config-object assertion would have passed while the real artefact lost it. CI now builds and greps the output.
- **A placeholder content script broke the load.** WXT emitted `content_scripts: [{ matches: [] }]` from a no-op entrypoint, and Chrome refuses the *entire* manifest for it — the extension does not load at all, and nothing in the build warns. It is deleted rather than given a match: the only way to make a placeholder valid is to request host access A-12 says we should not have yet. M2-10 adds the content script with real matches. `scripts/check-manifest.ts` now validates the built artefact against Chrome's load-time rules in CI.
- **Not done here:** the acceptance still needs a human. Nothing in this environment can load an unpacked extension in Chrome, so the popup-open-to-unlock number is unmeasured and M2-07 has no baseline yet.

---

### M2-02 · `<RhythmLight/>` · M · deps: M2-01 · X-1 · **DONE**

**Why.** X-1's promise is that the light is the consent signal: no visible light, no capture. `startCapture` already enforces it by throwing `RhythmLightNotVisible`, so this component's job is to make that guarantee legible rather than to re-implement it.

**Files:** create `extension/src/components/RhythmLight.tsx` (+test), `extension/src/components/useCapture.ts` (+test).

**What M1 changed, and this must honour.** `startCapture` now takes `onCancel(reason)` and records modifier keys and `blur`; `KeyEvent` is a union with a `blur` variant. So:
- **Surface every cancel reason.** `focus_lost`, `unsupported_key`, `unsupported_combo`, `malformed` each need distinct copy. M1-18 shipped five conditions collapsed into one bare "enroll rejected malformed", and it was unusable in the field — the demo needed a `?debug=1` panel before anyone could tell what had happened.
- **A submit control must not steal focus.** `preventDefault` on `mousedown`, or clicking Submit blurs the input, fires `blur`, and voids the sample the click was meant to send. This cost a full debugging session on the web demo.
- Paste, drop and `compositionstart` cancel the sample; say why, do not fail silently.

**Tests (happy-dom):** the light pulses once per keystroke; capture throws when the light is `display:none`, `visibility:hidden` or zero-size; each cancel reason renders its own message; `mousedown` on a sibling button does not cancel the sample; ARIA — `role="status"`, `aria-live="polite"`, and a label that states capture is active.

**Acceptance:** with the light hidden by CSS, capture refuses and says so on screen. The popup carries a "Hide the light" toggle so this is checkable by hand.

**As built — the cancel reasons do not arrive the way the ticket assumed.**

Writing the tests surfaced two things about `startCapture` that change what a screen has to do:

1. **`onCancel` only ever reports `unsupported_key`.** Paste, drop and `compositionstart` all funnel through one `abandon('unsupported_key')`, so three different mistakes are indistinguishable at the callback — the M1-18 failure one layer down. The hook therefore attaches its own `paste`/`drop`/`compositionstart` listeners purely for messaging, while capture independently voids the sample. No shared type changed; `ScriptError` is used by the server too and widening it for a UI concern would be the wrong trade.
2. **`focus_lost`, `unsupported_combo` and `malformed` are never raised during capture.** A blur is *recorded as a token*, and the error only appears when `eventsToScript` tokenizes. So `useCapture.stop()` tokenizes and reports, rather than handing back raw events — a caller that just took the events would show nothing and then fail server-side with no explanation. `stop()` returns `{ script, resolved, events }` or null, which is also what M2-03 and M2-05 need.

Also: the shared `unsupported_key` copy originally said "an arrow, a function key or similar", which would have been wrong for a paste. It no longer guesses at a cause it cannot know, and there is a test pinning that.

---

### M2-03 · Onboarding: passphrase, script, consent · M · deps: M2-02 · X-2 · **DONE**

**Why.** The account's whole key hierarchy is decided here, and two of its inputs cannot be changed later without a re-key.

**Files:** create `extension/entrypoints/popup/Onboarding.tsx` (+test), `extension/src/passphrase-strength.ts` (+test).

**Requirements.**
- Capture the script **twice and require the two to be token-identical** (A-14), not merely to resolve to the same text. Use `scriptsEqual`, which is constant-time.
- Show what was actually captured: **"12 keystrokes · 8 characters"**. This is the moment Phantom Keys become comprehensible, and the web demo showed people do not grasp them from prose.
- Minimum length **10 characters** resolved (B1 decision; 8 is the floor, 10 is the recommendation).
- Default Strictness to **Medium** and explain the Strict trade-off without offering it here — crossing into Strict is a re-key (A-16), which is M2-14's job.
- Record the A-12 consent checkbox with its policy version; `signup` already sends `consentAt` and `consentPolicyVersion`.
- Drives `session.signup({ resolved, script, strictness, username, email, ... })`. Note the credential shape: the session derives all three A-2 branches itself, so this screen never touches a KDF.

**Dependency:** `zxcvbn-ts`, approved 2026-09-05. **Measured cost: 224.8 KB gzipped of dictionaries plus 11.0 KB of core**, in a dynamic `import()` so neither is in the chunk the popup pays for on open. For comparison the initial popup chunk is 34.8 KB gzipped and the React runtime 59.1 KB. It is loaded on the onboarding screen only, once per install, and warmed while the user fills in their username.

**A-15 has no extension budget.** The site and the server binary have one and are enforced by `scripts/size-check.ts`; the extension is now the largest artefact and has none. Worth adding before M2-08 and M2-09 pull in more.

**A minimum length contradiction, unresolved in the docs and resolved here.** Three numbers were in play: the B1 decision said "at least 8, 10 is better", docs/03 X-2 says "≥ 3/4 and ≥ 12 chars", and this ticket said 10. Built to **12 and zxcvbn ≥ 3**, following docs/03 as the design document for this screen, and exposed as `MIN_PASSPHRASE_LENGTH` so it is a one-line change. The reasoning is asymmetric risk: too strict is fixed by loosening, while too loose leaves weak passphrases in the world permanently and tightening later would force a re-key (A-16). **Ruled 2026-09-05: 12 confirmed.** docs/03 X-2 records it; the B1 figures of 8 and 10 are superseded.

**Tests:** two token-different scripts that resolve alike are rejected; the keystroke/character counts match `scriptLength` and `resolveScript`; under-length is refused; consent is required; an absence test that no passphrase or script reaches storage.

**As built.**

- **React's `onChange` does not fire under happy-dom.** Verified across four dispatch variants on a minimal controlled input — direct assignment, the prototype value setter, `input` and `change` events, and `InputEvent`. `onFocus` and `onClick` work; the change plugin's value tracking does not. The identity fields are therefore **uncontrolled**, which is the better design here anyway: they have no formatting or as-you-type validation, so controlled state bought only re-renders during typing.
- **The submit button is never disabled for missing input; it says what is missing.** A disabled control with no stated reason leaves the user guessing which of three fields is at fault. This replaced a `disabled={!identityReady || !consented}` that was both untestable and worse.
- The strength dictionaries are warmed on mount, so the first check is a microtask rather than a ~2 MB import. Without that, `assessPassphrase` resolved after React's `act()` window and every assertion read a stale DOM.

---

### M2-04 · Recovery Kit screen · M · deps: M2-03 · X-2 · **DONE**

**Why.** This sheet is the only artefact that survives losing the device, and it will be read by someone years later who has nothing else.

**Files:** create `extension/entrypoints/popup/RecoveryKit.tsx` (+test), `extension/src/print.css`.

**Requirements.**
- The code is **33 characters** — 32 data symbols plus one Crockford check symbol. Not 32.
- Confirmation is "type 4 characters back" at random positions, not a full retype. It proves the sheet was saved without training anyone to type the Kit into a screen.
- The printable view and the on-screen copy must **both** carry: *"If you ever use this Kit, your authenticator app will need to be set up again. Your Backup Codes will still work."* A printed sheet carries no other context.
- **This screen is reused at the end of recovery.** M2-00f decided recovery retires the used Kit and issues a new one, so the same component must present a replacement Kit with the line *"The old one no longer works — save this one now."*
- The first set of **Backup Codes** arrives in the signup response and is shown once, here or immediately after. They are Backup Codes in every string; "Recovery" belongs to the Kit alone.

**Tests:** the rendered code is 33 characters and round-trips through `parseRecoveryCode`; a wrong confirmation character is refused; the print stylesheet includes the authenticator line; the replacement-Kit variant renders its own copy; an absence test that the code never reaches `chrome.storage`.

**As built.**

- One file outside the list changed: **`core/client/session.ts`**. The server has returned `backupCodes` from signup since M2-00e, but `SignupResult` dropped them on the floor — so "the first set of Backup Codes arrives in the signup response and is shown once, here" was not achievable. `SignupResult` now carries them.
- The confirmation accepts **Crockford lookalikes**: reading `O` where the sheet prints `0`, or `I`/`L` for `1`, is not a failure. The Kit alphabet excludes I, L, O and U precisely so a printed sheet is unambiguous, and punishing someone for the ambiguity the alphabet was designed to remove would be perverse.
- The authenticator warning lives **inside** the `.print-kit` section rather than beside it, so no print stylesheet change can drop it. The confirmation challenge is `no-print`: a printed "type 4 characters back" prompt is nonsense.
- Four characters rather than a full retype is not only convenience — a full retype trains the habit of typing a Recovery Kit into a screen, which is exactly what a phishing page would ask for.

---

### M2-05 · Enrollment screen · M · deps: M2-04 · **DONE**

**Why.** Eight samples is the longest uninterrupted stretch of typing the product ever asks for, and the M1 demo showed it is where people quit.

**Files:** create `extension/entrypoints/popup/Enroll.tsx` (+test).

**"Backspace retry" is withdrawn.** Backspace is a legitimate Phantom Key, so a sample containing one is not an error. The retry condition is a **script mismatch** against the enrolled script — `scriptsEqual` returning false — and the copy must say so: *"That was a different sequence of keys."*

**Requirements.**
- Drives `createEnroller({ request: session.authed(), token: enrollmentToken })`; every sample carries `commitments` from `session.commitmentsFor(script)`.
- Progress ring from `enroller.status()`, not a local counter, so a reload resumes correctly.
- **Do not ask for deliberately fast or slow samples.** Measured during M2-00g: six natural samples plus one slow and one fast raised the median feature std from 8 ms to 21.4 ms and lifted a stranger from 0.453 (fail) to 0.840 (comfortable pass). Widening the band admits everyone. Natural variability is learned from real logins.
- On `build()`, the server deletes the samples (A-4.6); show that as a reassurance, not a side effect.

**Tests:** eight samples advance the ring and the ninth is refused; a script mismatch retries without consuming a sample; a reload mid-enrolment resumes from `status()`; an absence test that no feature vector is persisted anywhere.

**As built.**

- `useCapture.stop()` now also returns the **feature vector**. Enrolment, login and step-up all need it alongside the script, and both come from the same events with the same token count — deriving it in the hook keeps `getFeatureRanges` agreeing with the commitments instead of asking three screens to remember to.
- **A mismatch is caught locally when the script is known, and by the server when it is not.** The script is never persisted (A-7), so a popup reopened mid-enrolment has lost it; the screen then submits and lets `script_mismatch` come back, mapping it to the same sentence the local check produces. The user cannot tell which path judged them, which is the point.
- The enroller is memoized. Building it per render changed `refresh`'s identity, refired the effect, set state, and looped — visible as a blank screen and a five-second test timeout rather than as an error.
- **A test that looked wrong and was not.** The Backspace case embedded a literal `0x08` in the source, which reads as an empty string in most tools; I read it as broken and nearly "fixed" it into a test that proved nothing. It now uses the `BACKSPACE` constant. Worth a rule: **never put a control byte in a test literal.**

---

### M2-06 · In-app Party Trick · S · deps: M2-05 · X-7 · **REMOVED 2026-09-07**

**Removed from the extension.** Founder's call after using the flow end to end: the demo
belongs on the marketing site, where a visitor with no account can try it, and not in the
manager itself, where it is a detour between finishing enrolment and reaching the vault.

It also cost something to keep. The screen needed the *resolved passphrase* in order to
show it to a friend, so `Onboarding` handed the plaintext up to the popup shell, which
held it in React state until the trick was dismissed. That is a copy of the credential
living longer and further from where it was typed, for a demonstration. Removing the
screen removed the copy: the passphrase now stops at the screen where it is typed.

The demo on `cypherkey.io` is unaffected, and X-7 is still met there.

**Why.** It is the moment the product explains itself, and the web demo already taught us its shape.

**Files:** create `extension/entrypoints/popup/PartyTrick.tsx` (+test).

**Carry over what the demo learned** (all four were real user complaints, not speculation):
- The friend gets **three attempts with a visible counter and an explicit "give up"** — one attempt reads as a fluke.
- When the keyboard comes back, **show the passphrase again**. The owner has not seen it for several minutes.
- **Never show a band and a verdict that disagree.** "0.69 PASS" beside "Stolen password neutralized" was the single most confusing thing in the demo; the verdict copy must be derived from the band, not written alongside it.
- A **Strictness lever** that re-judges the attempts already recorded, so the trade-off is felt rather than described.
- **Test another person** resets cleanly without re-enrolling.

**Tests:** three attempts then forced give-up; the verdict string is a pure function of the band; the lever re-judges recorded attempts without new capture; reset clears attempt state but not the profile.

**As built.**

- **It could not be built as scoped.** Scoring a friend's attempt through `/auth/login` would march the owner's account toward a lockout during their own demo, and would file rows in `auth_score_history` describing someone who is not the account holder. One file outside the list — `server/src/routes/user.ts` — gained `POST /user/demo-score`, which scores and returns and does nothing else. Tests assert it never touches lockout, history, the profile or tokens.
- **The raw score comes back to the client**, which is what lets the Strictness lever re-judge attempts already recorded without asking the server again — the lever is the point, and a server-side band would make it a second round trip and a lie about what changed.
- **A phantom mismatch is reported rather than refused** (200 with `phantomsMatched: false`), because the demo needs to *show* the phantom check failing. A 401 would have nothing to display.
- **The verdict is a pure function of the band**, exported and tested separately. "0.69 PASS" beside "Stolen password neutralized" was the single most confusing thing in the web demo; deriving one from the other makes that combination unrepresentable.
- **No raw score is shown.** A number invites hill-climbing and means nothing to the person reading it.
- It is offered **once, straight after enrolment**, and needs the resolved passphrase — which exists only in memory during that flow. After a reload there is nothing to show a friend, which is the second reason it is a one-time screen.

---

### M2-07 · Unlock screen · L · deps: M2-00e, M2-05 · X-3 · **DONE**

**Why.** The ladder in X-3 is the product's answer to "what if my hands are different today", and it is the screen every user sees most.

**Files:** create `extension/entrypoints/popup/Unlock.tsx` (+test); modify `core/client/session.ts` (+test).

**A prerequisite this ticket owns.** `StepUpInput` is `{ method: 'retype', script, featureVector }` — retype only. M2-00e built the server side of `backup_code`, but **no client can drive it**, so the e2e does not cover that path. Widen the type to a discriminated union and add the `backup_code` branch here:
```ts
type StepUpInput =
  | { method: 'retype'; script: string; featureVector: number[] }
  | { method: 'backup_code'; proof: string };
```

**Requirements.**
- Bands drive everything: pass unlocks; grey shows *"Your rhythm looks different today. Type it once more."* and scores the average; a failed grey offers step-up.
- Step-up offers **Backup Codes** — never "recovery codes". The Recovery Kit is not offered here; it opens a vault, not a session, and belongs to the "forgot passphrase" path.
- **"Forgot passphrase" drives the real M2-00f flow**: `session.recover()`, which verifies the Kit before anything is released, and ends on M2-04's replacement-Kit screen. Not a client-side unwrap.
- A failed step-up now counts toward lockout (M2-00e); surface the remaining attempts before the account locks, or the lock arrives unexplained.
- Offline: `session.unlockOffline(credential)` when the network is gone, per A-7.

**Tests:** each band renders its own state; a grey retype that clears unlocks; a Backup Code clears step-up and the used code is reported spent; lockout copy appears before the lock; offline unlock works with a cached blob and fails cleanly without one.

**Acceptance:** the e2e gains a Backup Code step-up leg, driven through `core/client`. Done — steps 12 and 13, including that a spent code is refused the second time.

**As built.**

- `StepUpInput` is now a discriminated union. The `backup_code` path had existed server-side since M2-00e with **no client able to reach it**, so it shipped untested end to end for two tickets; the e2e now exercises it.
- **The lockout warning claims no number.** The server answers 401 whether one attempt remains or four, so an exact count would be a lie the moment a second device or an earlier session has spent part of the budget. The screen warns after two failures it has seen itself and says what will happen, not how close it is.
- **The Recovery Kit is deliberately absent from step-up.** A Backup Code opens a session; the Kit opens a vault. Offering the Kit here would teach people to type it into an unlock screen, which is what A-1 principle 7 forbids. There is a test asserting the string never appears.
- The backup-code field is uncontrolled, like M2-03's identity fields, and the test asserts the **proof value** travelled rather than only the method — asserting the method alone would have passed even if the field were never read.

**The e2e needed a shared clock.** The A-8 account bucket is ten requests a minute and does not refill on a frozen clock, so adding this leg made a *later* step 429 for reasons unrelated to itself. Client and server now share one injected clock that advances between phases; they must share it, because `verifyDeviceSignature` allows 30 s of skew and moving one side alone invalidates every signature.

---

### M2-08 · Vault list, search and item editing · L · deps: M2-07 · X-6 · **DONE**

**Why.** The vault is the reason anyone tolerates the rest.

**Files:** create `extension/src/vault/{item,codec}.ts` (+tests), `extension/entrypoints/popup/{VaultList,ItemView,ItemEdit}.tsx` (+tests).

**Interfaces.** An item is plaintext only in memory; `codec` is the single place that encrypts and decrypts:
```ts
type VaultItem =
  | { kind: 'login'; id; title; host; username; password; notes?; updatedAt }
  | { kind: 'note';  id; title; body; updatedAt };
encodeItem(item, vaultKey): Promise<{ ciphertext: string; nonce: string }>
decodeItem(wire, vaultKey): Promise<VaultItem>
```
AAD is the item id, as `encryptItem` already requires, so a ciphertext cannot be moved between items.

**Dependency:** `fuse.js` for fuzzy search — but the list is small and local; a substring match over title and host may be enough. Ship the simple one unless it demonstrably fails.

**Tests:** round-trip every item kind; a ciphertext re-labelled with another id fails to decrypt; search ranks title above host above username; an absence test that no plaintext reaches storage or logs.

**As built.**

- **`fuse.js` was not added.** Search is a ranked substring match over three fields; the list is local and small, and a dependency here would cost download size on every popup open for a problem this does not have. Revisit when real vaults make it feel wrong.
- **A password is never searchable.** Matching on it would let anyone with the vault already open confirm a guess by typing it into the search box, and would surface entries for a reason invisible on screen. Note bodies *are* searchable, because they are content rather than a secret field.
- **A password is never trimmed, though a title is.** Leading or trailing spaces are legitimate in a password, and silently removing one locks the user out of the site with no visible cause.
- `decodeItem` takes the item id from the **envelope**, not the payload. Trusting an id inside the ciphertext would defeat the binding — the decryption has to be attempted against the id the server filed it under.
- A decrypted payload is authenticated but still validated: it may have been written by an older version, and a malformed entry rendering as `undefined` throughout the UI is worse than a named error.

**Corrected while doing this:** M2-07 claimed the unlock screen was wired into the popup and it was not. The edit had silently missed after biome reformatted the block, leaving `Unlock` imported and never rendered, and I did not check the file afterwards. The shell now runs the whole path — onboarding, Kit, enrolment, unlock, vault. **A `python` replace that prints success is not evidence the edit landed.**

---

### M2-09 · Local cache, sync engine and offline queue · L · deps: M2-08 · A-6, A-7 · **DONE**

**Why.** Without this the vault is unusable on a train, and A-6's conflict rules only exist client-side.

**Files:** create `extension/src/sync/{cache,engine,queue}.ts` (+tests).

**Requirements.**
- Cache ciphertext in IndexedDB, never plaintext. Decrypt on read into memory only.
- **A 409 from `sync.push` is a partial success, not an error.** The clean items in a mixed batch were applied; the conflicts come back with the server copy. Treating it as failure silently drops writes that actually landed — the client library got this wrong once already and `sync.ts` documents it.
- **Honour `key_version`.** A Strict re-key (M1-17c) or a recovery (M2-00f) bumps it, and every other device's cached blob is then undecryptable. Detect the bump and re-sync from zero rather than surfacing a decryption error.
- The offline queue replays in order on reconnect and survives a popup close.

**Dependency:** `idb`, or hand-rolled — the schema is one object store.

**Tests:** a 409 applies the clean half and reports the conflicts; a `key_version` bump triggers a full re-sync; a queued write survives a simulated restart; cursor paging resumes correctly; an absence test that IndexedDB holds no plaintext.

**As built.**

- One file outside the list changed: **`core/client/session.ts`**. `key_version` was returned by login and dropped by the client, so cache invalidation was impossible. `LoginResult` now carries it on a pass. That is the fourth time this milestone the server has produced something the client discarded.
- **`idb` was not added.** The cache is one object store with four operations behind a `KeyValueStore` seam, so IndexedDB backs it in the browser and a map backs it in tests. The wrapper would have cost download size on every popup open to save about thirty lines.
- **`open()` does not throw when the server is unreachable.** It reports `pulled: false` instead. Opening the vault on a train has to show what is cached — A-7 says so — and the first draft would have failed the whole unlock. A key-version bump still clears the cache in that case, because those blobs are undecryptable whether or not the network is up.
- **Editing the same item twice offline queues one write, not two.** Replaying both would push a stale version and manufacture a conflict against ourselves.
- The queue holds ciphertext and is persisted: a popup closes the moment it loses focus, and an edit typed thirty seconds earlier must not go with it.
- An offline unlock reports `keyVersion: 0`, meaning "no server to ask". The cache keeps what it believes and detects a re-key on the next online unlock, which is the earliest it can be known.

---

### M2-10 · Content script: detection and domain-bound autofill · L · deps: M2-09 · X-6 · **DONE**

**Why.** Highest bug risk in the milestone, and the only place a mistake fills a credential into the wrong site. **Budget two passes.**

**Files:** create `extension/entrypoints/content/{detect,fill,banner}.ts` (+tests).

**Requirements** (from the original guidance, unchanged): detect `input[type=password]` plus the nearest preceding text/email input in the same form; fall back to `name`/`id`/`autocomplete` heuristics. **Never fill unless `location.origin`'s host matches the item's saved host exactly, or as a registrable-domain match via `tldts`.** If the host contains `xn--`, show a warning banner and refuse to fill.

`tldts` is the only new dependency.

**Tests:** a fixture set of real login-form shapes; a punycode host refuses and warns; a subdomain of the saved registrable domain fills; a different registrable domain does not; an `<iframe>` on a foreign origin never receives a fill.

**As built (first of the two passes this ticket was budgeted).**

- **`tldts` in the content script cost 265 KB on every page.** The public suffix list was bundled into a script that runs everywhere, to answer a punycode question that is a substring check. Splitting `isPunycodeHost` into `banner.ts` — which imports nothing — took the content script to **5.5 KB**. A test asserts that neither the banner, the detector nor the entrypoint imports `tldts` or `fill.ts`.
- **The content script never fills.** It detects and warns; a fill happens only when the user asks through the popup. A script that filled on sight would put a credential on the page before anyone had looked at the address bar.
- **Only punycode earns a banner.** A different site or a subframe is an ordinary "not here", and interrupting for those trains people to dismiss the banner unread — which is exactly when the one that matters arrives.
- **Every refusal names itself** — `punycode`, `different-site`, `subframe`, `unknown-host` — and a test asserts all four are distinct. A silent no is indistinguishable from a bug.
- `getDomain` returns null for localhost, IPs and intranet names. Null is **not** treated as a match, or every intranet host would be equivalent; exact equality is the only route for those.
- **Two password fields are not a sign-in.** Autofilling a change-password form with the current password looks like it worked and silently sets the new password to the old one.

**Permission posture: `activeTab`, not `<all_urls>` (ruled 2026-09-05).** The first pass shipped an `<all_urls>` content script, which is what a password manager usually asks for; it was given up deliberately. The extension holds `activeTab` and `scripting`, so it reaches a single tab only after the user invokes it there, and has **no standing access to browsing at all**. The filler is built as an unlisted script and injected on demand; being in the package is not being active, and a test asserts `content_scripts` is empty.

**The cost, stated rather than absorbed:** nothing runs on pages the user has not pointed the extension at, so **the punycode lookalike warning now appears when a fill is requested rather than when the page loads**. That is still before any credential is released, but it cannot help someone who types a password by hand on a lookalike domain — which was the case the eager banner was most useful for. If beta shows people meeting lookalikes that way, the options are an opt-in per-site permission or a narrow `<all_urls>` script that *only* warns and never fills.

**Second pass, done.**

- **The credential travels as an `executeScript` argument, not by message.** Arguments are structured-cloned into the one call and go nowhere else; a message listener sitting in the page waiting to be told a password is a strictly larger target for anything else running there. A test asserts no `onMessage`/`sendMessage` appears in the module.
- **Nothing is injected unless `decideFill` allowed it.** The decision happens in the popup, so a page on the wrong host never receives the script at all — the refusal costs it no information beyond the fact that the popup was opened.
- **The A-15 budget caught a 110 KB regression.** Importing `autofill.ts` from `ItemView` pulled `decideFill` and therefore `tldts` into the eager popup chunk: 105.7 KB → **216.4 KB**, against a 150 KB budget. The suffix list belongs to the one action that needs it, so the import is now dynamic and the popup is back to 105.9 KB. Without the budget this would have shipped as a slower popup nobody could explain.
- **The injected function is tested by running it**, against a real DOM, rather than by grepping its source — `executeScript` serialises it, so a mistake inside only surfaces when it executes. Two password fields fill nothing; a disabled field is not a field; an empty username does not overwrite what is there.
- **Every refusal has its own sentence**, and a test asserts the six are distinct. "It did not work" is indistinguishable from a bug.

**Still not done, and worth stating:** the inline in-page icon. The `activeTab` posture makes it awkward — an icon that appears on a page requires something running on that page, which is the standing access the posture gives up. Filling is driven from the popup instead. Revisit only if beta shows people cannot find it.

---

### M2-11 · Generator · S · deps: M2-08 · **DONE**

**Files:** create `extension/src/generator.ts` (+test), `extension/entrypoints/popup/Generator.tsx` (+test).

Random-character and passphrase modes, `crypto.getRandomValues` only, with rejection sampling so the alphabet is unbiased — the modulo shortcut is fine for a 32-symbol alphabet and wrong for most others. One-click fill into the item being edited.

**Tests:** the distribution is unbiased across the alphabet; length and class options are honoured; `Math.random` appears nowhere in the file.

**As built.**

- **Rejection sampling, tested by construction rather than by sampling.** Feeding every byte 0–255 through a 62-symbol alphabet produces an exactly flat distribution; a `byte % 62` shortcut would map 248–255 onto the first eight symbols and make `a`–`h` 25% more likely. A second test feeds *only* the bytes a modulo shortcut would fold and asserts none of them yields a symbol.
- **Entropy is stated in bits, not implied by a colour.** A green bar tells the user they did well; a number tells them what an attacker faces, and for a value we generated ourselves that is the only claim we can stand behind. There is a test that no `progressbar` or "Strong"/"Weak" label exists to mislead with.
- **The word list is exactly 256 words**, so a word is exactly 8 bits and the figure shown is whole. It was 233 when first written, which made the "8 bits a word" comment quietly false — a test now pins the count. A larger list (EFF's 7776) would buy shorter passphrases at roughly 100 KB in the popup.
- **Ambiguous characters are excluded from every class**: no `l`, `I`, `O`, `0`, `1`. A generated password gets read aloud and retyped from a screenshot; `0` versus `O` costs more in support than the fraction of a bit it adds.
- The generator sits **inside the item editor**, one click from the field it fills. Behind a separate screen it is one people stop using, and the password they invent instead is the problem it exists to solve.

---

### M2-12 · Idle lock, lock on close, memory zeroing · S · deps: M2-07 · **DONE**

**Files:** create `extension/src/lock.ts` (+test).

`session.checkIdle()` already implements A-5's 15-minute rule; this wires it to a real timer, to popup close, and to browser lock/sleep. Every `Uint8Array` holding key material is zeroed on lock — `session.lock()` does its own, so the ticket covers what the *extension* holds beyond it.

**Tests:** idle past the timeout locks; activity defers it; closing the popup locks; after lock, `vaultKey()` throws and no key material is reachable from any module-level reference.

**As built.**

- **The decrypted items are the thing that actually needed this.** `session.lock()` zeroes vault, wrap and phantom keys and knows nothing about what the extension built from them; a `VaultItem[]` in React state is a list of plaintext passwords. Zeroing a 32-byte key while leaving those alive locks the door and leaves the window open. The popup subscribes and clears them.
- **Subscribers run before the session zeroes its keys**, so a future subscriber that needs the vault key to tidy up — re-encrypting a draft — is not handed a zeroed one. Nothing does that today; the ordering exists so nothing has to discover it later. A throwing subscriber cannot stop the others: locking is not optional.
- **The KDF worker is terminated on lock.** It received `kdfInput`, which is the passphrase, and another thread's heap cannot be zeroed from here — ending it is the only assurance available.
- **`dispose()` deliberately does not lock.** It is teardown, and a re-render must not throw the user out.
- **`forget()` is honest about its limit.** A JavaScript string is immutable and may already have been copied by the engine, so only the last *reference* can be dropped; a test asserts exactly that rather than pretending the bytes were erased. Anything that must be truly zeroable is a `Uint8Array` from the start, which is why every key in `core/crypto` is one.

---

### M2-13 · Import Bitwarden JSON and Chrome CSV · M · deps: M2-08 · **DONE**

**Files:** create `extension/src/import/{bitwarden,chrome-csv}.ts` (+tests), `extension/entrypoints/popup/Import.tsx` (+test).

Parse, map to `VaultItem`, report per-row failures without aborting the batch, and never write an imported file to disk. A malformed row is skipped with a reason, not silently dropped.

**Tests:** fixtures for both formats including malformed rows; totals reconcile (imported + skipped = rows); an absence test that no imported plaintext is logged.

**As built.**

- **The CSV reader is hand-rolled to RFC 4180 rather than `split(',')`.** That shortcut corrupts any field containing a comma — and a password is exactly that field. The row still parses, the import still reports success, and the user finds out weeks later when a site rejects a password they can no longer recover. Quoted fields, `""` escapes and newlines-inside-quotes are all tested, as is a password of `a,b,c` surviving end to end.
- **A skipped row says why, by name.** "Visa is a card, which CypherKey cannot hold yet" rather than a silent drop. Reshaping a card into a login would lose the number and present it as something it is not; saying what was left behind is the honest option.
- **A whole-file problem is one message**, not a per-row complaint about every line — an encrypted Bitwarden export says how to export unencrypted instead.
- **Nothing is saved until the preview has been seen**, and the totals reconcile: `imported + skipped = rows`.
- The parsed plaintext is dropped as soon as the import completes; holding it would keep every imported password alive for no reason. A test asserts the screen writes nothing to disk, storage or the console, and that a skipped reason never quotes a password.

---

### M2-14 · Settings, and the A-17 re-auth the server still owes · M · deps: M2-07 · X-4, A-16 · **DONE**

**Why.** This ticket carries a **server change**, which is why it is not simply a screen.

**Files:** create `extension/entrypoints/options/Settings.tsx` (+test); modify `server/src/auth/require.ts`, `server/src/routes/user.ts` (+tests).

**The server change.** A-17 requires every step-up-gated settings change to carry **the passphrase in that request**: Pause, Strictness, Backup Code regeneration, TOTP enrolment. M1-13 shipped a weaker check — a `stepUpAt` claim on the access token, good for five minutes — which cannot produce `stepUpKey` and therefore cannot re-wrap a TOTP secret. Replace `hasFreshStepUp` with an in-request re-auth. `POST /user/backup-codes` (M2-00e) already does it this way and is the pattern to copy.

**The screens.** Device list with revoke; biometric toggle; Pause with its A-16 warning; and the **Strictness slider** — Medium↔Relaxed is a settings edit, but crossing into or out of **Strict is a re-key**: `session.changeStrictness()` re-derives everything and the warning must say that the Recovery Kit stays valid while every other device must re-authenticate.

**Tests:** a settings change without the passphrase in the request is refused; with it, accepted; a Strict crossing bumps `key_version` and leaves the Recovery Kit working; revoking a device kills its refresh family.

**As built.**

- **`hasFreshStepUp` and `STEP_UP_FRESHNESS_MS` are deleted, not deprecated.** Both were unreferenced once `requireReauth` landed, and leaving a helper named "fresh step-up" in the tree invites someone to reach for it. The `stepUpAt` claim stays on the token but is now explicitly informational — the audit log and the Rhythm Signature view want to show it; nothing gates on it.
- **`/user/rekey` needed a second hash.** It already carried `authHash`, but that is the value the account will hold *after* the crossing — a value the caller chooses, proving nothing. `currentAuthHash` is now required and verified. The client derives both, which costs two Argon2id passes because crossing Strict changes `kdfInput` and the two hashes are genuinely different values from the same passphrase.
- **Even Medium ↔ Relaxed carries the passphrase.** It is a settings PATCH rather than a re-key, but it still loosens an account, and the server refuses it without one.
- The two guard tests that asserted "a token without a fresh step-up is refused" were rewritten rather than patched: under A-17 an ordinary access token **is** enough, given the passphrase, and freshness is irrelevant. Testing the old rule would have hidden the change.

---

### M2-15 · "Not your rhythm" email · S · deps: none · **DONE**

**Files:** create `server/src/mail/{client,templates}.ts` (+tests); modify `server/src/routes/login.ts`.

X-3 calls this a feature, not a notification: *"Someone typed your passphrase but didn't match your rhythm"* is the dark-web-breach email inverted, and it is the clearest proof the product works. Sent on a **fail** band, rate-limited to one per account per hour so a lockout attempt cannot be turned into a mail flood.

`resend` is the dependency; the transport must be injectable so tests send nothing.

**Tests:** a fail sends once and a second within the hour does not; a grey or pass sends nothing; the body contains no score, no vector and no device detail beyond a coarse location; the transport is never called in tests.

**As built.**

- **The throttle lives in `audit_log`, not `rate_limits`.** Reusing the rate-limit table looked obvious until reading its `prune`, which deletes anything idle for ten minutes — a one-hour throttle stored there would have silently let a second email through at minute eleven. A throttle that quietly does not hold is worse than none. There is a test that advances eleven minutes and asserts it still holds. "We emailed this user" is also a genuinely auditable event, so the row belongs there.
- **`resend` was not added.** It is one POST, and the seam that matters — `Transport` — is already injected. A dependency would buy typed errors for a call whose only outcomes are "sent" and "did not send". A hand-rolled `resendTransport` and a `noopTransport` ship instead.
- **A provider outage is not a login failure.** A throwing transport is reported rather than raised, and a failed send is *not* recorded — so the next failure retries instead of being throttled out by a send that never happened.
- **The mailer is optional on `createApp`.** A self-hosted instance with no provider simply does not send, rather than failing logins it cannot email about.
- **The body carries no score.** A score would tell an attacker how close they got, which is a hill-climbing signal, and a mailbox is often the first account an attacker compromises. Location is coarse or absent — it says "somewhere" rather than inventing precision.

---

### M2-16 · Hosted deploy · M · deps: M2-00f

**Files:** create `deploy/` (Cloud Run service, Cloud SQL, Secret Manager wiring), `.github/workflows/deploy.yml`; modify `docs/07`.

Cloud Run plus Cloud SQL plus Secret Manager, with the status page. The image is the existing distroless build; Postgres is reached over the network via `DATABASE_URL` and is never part of the image.

**Settled 2026-09-05: everything is GCP, marketing site included.** The site is part of this application, not a separate property, so it deploys here rather than staying on Cloudflare Pages — one deploy path, one place to look when something breaks. `docs/04`, `docs/07` and the README are corrected. This ticket therefore covers Cloud Run + Cloud SQL + Secret Manager **and** the static site (Cloud CDN + Cloud Storage, Cloud Armor in front). The M0-06 Pages config is superseded; remove it here rather than leaving a second deploy path in the repo.

**Acceptance:** a deployed instance passes the e2e against `DATABASE_URL`, and the size budgets still hold.

**Blocked on console work, tracked in `gcp.md`** at the repo root — a step-by-step list with a status column the founder updates as they go. Five values unblock the rest of this ticket: project ID, project number, region, Cloud SQL connection name, and the workload identity provider resource name. Once those exist I can write `deploy/`, the Cloud Run service definition and the deploy workflow without further console access.

**Runtime settings the build already constrains**, recorded there so the service is not misconfigured on the first try: the image is distroless with no shell, so Cloud Run must probe `/healthz` rather than relying on a Docker `HEALTHCHECK`; minimum instances 1, because Argon2id at m=64 MiB on a cold start looks broken and a login is the first thing anyone does; at least 1 GiB of memory and concurrency around 20, because each in-flight hash holds 64 MiB and the default 80-per-instance concurrency is how the limit gets hit.

---

### M2-17 · Beta feedback link · S · deps: M2-01 · **DONE**

**Files:** create `extension/entrypoints/popup/Feedback.tsx` (+test).

Opens a prefilled GitHub issue template. **It must not attach logs, scores, vectors or vault contents** — the template asks the user to describe what happened, and carries only the extension version and browser. Anything auto-attached from a zero-knowledge client is a leak waiting to be discovered.

**Tests:** the generated URL contains version and browser and nothing else; no capture or vault state is reachable from the component.

**As built.**

- **The user-agent is reduced to a name and major version.** The full string is a fingerprint — platform, architecture, build number, often enough to single someone out — and "Chrome 141" is all a maintainer needs to reproduce a bug. Tests assert no build number, platform or architecture survives, and that Edge and Opera are not reported as Chrome.
- **The component takes no session, vault or capture prop.** That is structural rather than disciplinary: there is nothing here that *could* attach diagnostics, so an edit that wanted to would have to add a prop and explain itself in review. A test greps the source for those names.
- **The screen says outright that nothing is attached**, and shows the exact line that will be sent before sending it. A bug report from a password manager *sounds* like it might carry diagnostics; saying it does not is worth more than being quietly correct.
- The body warns against pasting a passphrase, Recovery Kit or Backup Code, because a GitHub issue is public and someone will otherwise paste a screenshot.

**Resolved 2026-09-07: no code change needed.** `FEEDBACK_REPO` points at `IrietekCorp/cypherkey`, which is the repo that will be made public. The constant is already correct; the remaining action is flipping the repo's visibility before a build goes to anyone outside the org. Until that happens a non-collaborator tester still sees a 404, so this is a release gate rather than a bug.


---

### M2-18 · The session survives the popup closing · M · deps: M2-12 · **DONE**

**Files:** create `extension/src/resume.ts` (+test); modify `core/client/session.ts`,
`extension/entrypoints/popup/App.tsx`, `extension/src/lock.ts`.

Founder's report after using the flow: "it should remember that I'm logged in for at
least 24 hours, so that when I go back to it, I don't have to always unlock."

M2-12 locks on popup close, and the popup is destroyed every time it loses focus. So
every open cost another Argon2id derivation and another rhythm sample. That is correct
and unusable, and the two are not in tension the way they look: a manager nobody keeps
unlocked is a manager people stop putting passwords into, and M2's exit criterion is
that the founder uses it daily.

**Where the keys live is the whole decision.** `chrome.storage.session` — browser
memory, wiped on shutdown. **Never `storage.local`.** A-7 permits five things on disk and
none is a live key; a vault key written to disk means a stolen or imaged laptop opens the
vault with no passphrase and no rhythm, which is the threat this product exists to
answer. Closing Chrome is therefore a real lock, and that is a feature rather than a
shortcoming. The browser test asserts nothing resumable reaches `storage.local`.

**Two deadlines, whichever comes first.** A 24-hour cap from the moment the passphrase
and rhythm were actually checked, and a 1-hour idle timeout. Both are stored beside the
keys rather than held in the popup, because the popup dies constantly and a deadline it
forgets is not a deadline. Activity pushes the idle limit out; nothing pushes the cap,
which is what makes it a cap.

**A-5 deviation, stated.** A-5 specifies fifteen minutes of idle and this is an hour. A
session that survives the popup closing measures idle against the *browser* being idle,
not against a popup dismissed the moment it loses focus — fifteen minutes of that is a
lock every time the user glances at another tab. The 24-hour cap is what keeps the
widening bounded.

**`popup-closed` is the one lock that does not end the session.** The page is destroyed
either way, so its keys go regardless; what differs is whether the next open may resume.
Idle, manual and suspend are the user or the clock saying stop, and they clear the
snapshot. Without that distinction the snapshot would be wiped every time the popup lost
focus, which is the behaviour being fixed.

**What `SessionSnapshot` is.** The most dangerous object in the library: the vault, in
the clear. Keys are base64url because it crosses a structured clone, and that has a cost
worth naming — a string cannot be zeroed, so `clear()` drops a reference rather than
erasing bytes. `resumeFrom` deliberately checks no passphrase, because possession of the
snapshot *is* the credential; that is exactly why the caller owns the expiry and why the
only legitimate home is memory the browser wipes.

**Refused rather than repaired.** A snapshot whose `lastActiveAt` precedes its
`unlockedAt` — a clock that moved backwards — would make both elapsed checks read as "no
time has passed", an unlock that never expires. Treated as malformed and cleared, along
with wrong-length keys and missing fields.

---

# E-DESIGN — Visual and experience redesign · **epic, not yet ticketed**

Raised 2026-09-07. The site, the one-pager and the extension UI all grew out of M0's
"make it credible fast" pass and have never had a deliberate design phase. This is that
phase, kept as a separate epic so it does not get half-done inside feature tickets.

**Not yet scoped.** Before it is ticketed, decide what it covers: the marketing site, the
one-pager, the extension's screens, or all three; whether there is a design system worth
naming (type scale, colour, spacing, the Rhythm Light's visual language) or only a
tidy-up; and whether any of it blocks the private beta or waits until after it.

**Standing constraints for whoever does it.** The Rhythm Light is a consent indicator
before it is an aesthetic element — X-1 says a service that hides the light gets no data,
so it may be restyled but never made subtle. The Recovery Kit screen is printable and the
line that must survive printing is load-bearing. Nothing in a redesign may add a network
request to a page that currently makes none.

# M3+ (summary; ticket out when you get there)

**M3:** adaptive thresholds (per-user pass/grey from score history percentiles), per-device profiles (keyed on the Ed25519 `device_id`; no within-device rhythm clustering — see the keyboard ticket), passkey and TOTP step-up (`@simplewebauthn`, `otpauth`), **M2-00g** (adapt after a verified step-up — deferred here because it cannot be built until step-up exists), Rhythm Signature view, Precision Mode flag, Firefox build, docs site (Astro Starlight), SECURITY review fixes, launch checklist.
**M4:** Stripe, HIBP, CLI (Bun compiled binary; raw-mode capture via `readline`/`tty` with `process.hrtime`), passkey items, SSE push, emergency access.
**M5:** `@cypherkey/sdk` (consent-enforced capture, enrollment status, verify), service dashboard, Teams, rhythm-gated passkeys, Redis, load test.
**M6:** OIDC provider (`oidc-provider` or hand-rolled minimal), mobile read-only, SOC 2 checklist.

---

## Definition of Done (every ticket)

- [ ] Tests named in the ticket exist and pass; `bun test` green
- [ ] `bun run typecheck` and `bun run lint` green
- [ ] No files outside the ticket's list changed (`git diff --stat`)
- [ ] No new dependencies beyond those named
- [ ] No secrets, no `console.log` of key material, no persisted feature vectors
- [ ] You ran the acceptance check yourself
- [ ] Commit message: `M1-09: login scoring and bands`
