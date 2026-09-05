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

### M2-00h · Capture without a DOM · M · deps: M1-16 · **approved in principle**

`startCapture(input: HTMLInputElement, light: HTMLElement)` is DOM-bound and throws without a visible Rhythm Light element. A terminal has neither, and M4's CLI ticket walks straight into it; mobile and desktop interfaces will too.

AGENTS already anticipates the split — "no DOM imports except `core/biometrics/capture.ts`" — but there is no non-DOM path today.

**The division that must hold.** `core` owns the `KeyEvent` contract, the A-14.1 tokenizer, the feature layout and the *rule* that capture requires a visible consent indicator. Each platform supplies an adapter that proves it has one: a visible element in the browser, a rendered indicator line in a TTY, the platform equivalent elsewhere. The rule is not that a DOM node exists; it is that the person can see the light. X-1 says a service that hides the light gets no data, and that has to survive the move off the DOM rather than being quietly dropped as untestable.

**Files:** create `core/biometrics/capture-contract.ts` (the adapter interface plus a `RhythmLight` proof type) and a test; refactor `core/biometrics/capture.ts` into the DOM adapter behind it. No behaviour change in the browser.

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

Verified against the source, not recalled. Every M2 ticket must be written against these signatures; where a ticket needs something absent here, the ticket has to create it.

```ts
// core/client/session.ts
createSession(deps: SessionDeps): Session
type Session = {
  state(): SessionState;                      // 'locked' | 'unlocked' | 'step-up-required'
  signup(input: SignupInput): Promise<SignupResult>;        // → { userId, recoveryCode }
  login(input: LoginInput): Promise<LoginResult>;           // → pass | grey+stepUp | fail
  stepUp(method: string, proof: string): Promise<LoginResult>;
  unlockOffline(input: Credential): Promise<boolean>;
  changeStrictness(input: StrictnessChange): Promise<{ keyVersion: number } | { error: string }>;
  lock(): void; touch(): void; checkIdle(): void;
  vaultKey(): Uint8Array;                     // throws while locked
};
// NOT PRESENT: any enrollment method, any vault method. M2-00d creates both.

// core/biometrics/capture.ts
startCapture(
  input: HTMLInputElement,
  light: HTMLElement,
  opts?: { onPulse?: () => void; onCancel?: (reason: ScriptError) => void },
): { stop(): KeyEvent[]; cancel(): void }      // throws 'RhythmLightNotVisible'

// core/biometrics/script.ts
eventsToScript(events: KeyEvent[]): { script: string; resolved: string } | { error: ScriptError }
eventsToTokens(events: KeyEvent[]): TimedResult | { error: ScriptError }
scriptsEqual(a: string, b: string): boolean    // constant-time
scriptLength(script: string): number           // code points, not characters
resolveScript(script: string): string
BACKSPACE '\u0008' · DELETE '\u007F' · ESCAPE '\u001B' · MODIFIER_TOKENS '\uE000'–'\uE004'

// core/biometrics/features.ts / score.ts
extractFeatures(events: KeyEvent[], expectedLen: number): FeatureVector | FeatureExtractionError
getFeatureRanges(len: number)                  // vector length is 3n + 5
buildProfile(samples) · score(profile, sample) · band(s, pass?, grey?) · adapt(profile, sample, alpha?)

// core/crypto/phantom.ts
kdfInput(resolved: string, script: string, level: Strictness): Uint8Array
scriptCommitments(phantomKey: Uint8Array, script: string): Promise<Uint8Array[]>
budget(level, canonLen): { maxInsertions: number; maxMissing: number }
rhythmBands(level): { pass: number; grey: number }

// core/crypto/recovery.ts
generateRecoveryCode(): string                 // 33 chars: 32 data + 1 check symbol
parseRecoveryCode(code) · recoveryKeyFromCode(code) · formatRecoveryCode(secret)
```

### Corrections to the rows below, from what M1 actually built

- **M2-02** — `startCapture` now takes `onCancel(reason)` and records modifier keys and `blur`; `KeyEvent` is a union with a `blur` variant. The component must surface cancel reasons, and a submit control must not steal focus (see the M1-18 follow-up: `preventDefault` on `mousedown`).
- **M2-03** — onboarding must capture the script **twice, token-identical** (A-14), show "12 keystrokes · 8 characters", default Strictness to Medium, and record the A-12 consent checkbox.
- **M2-04** — the Recovery Kit code is **33 characters**, not 32. The printed Kit and the on-screen copy must both carry: *"If you ever use this Kit, your authenticator app will need to be set up again. Your Backup Codes will still work."* Someone reading the sheet years later has only what is printed on it.
- **M2-07 / M2-03, new** — recovery is now a real server flow (M2-00f): the Kit is verified before the wrapped vault key is released, `begin` is read-only, and the commit is one transaction. Any "forgot passphrase" screen must drive that, not a client-only unwrap.
- **M2-05** — "backspace retry" is withdrawn: Backspace is a legitimate Phantom Key. The retry condition is a **script mismatch**, and every sample carries commitments.
- **M2-07** — the server accepts **`retype` only**; `step_up_factors` is a table no route touches. **M2-00e above now covers this** and is a hard prerequisite: M2-07 cannot start until it lands. M2-00e also fixes a hole it uncovered — a failed step-up does not currently count toward lockout. The screen says **Backup Codes**, never "recovery codes".
- **M2-14 and the server, new** — A-17 requires every step-up-gated settings change to carry **the passphrase in that request**: Pause, Strictness, Backup Code regeneration, TOTP enrolment. M1-13 shipped a weaker check — a `stepUpAt` claim on the access token, good for five minutes — which cannot produce `stepUpKey` and so cannot touch a TOTP factor. Someone has to replace `hasFreshStepUp` with an in-request re-auth; M2-14 owns the screens and the server change should land with it.
- **M2-09** — the cache must honour `key_version`: a Strict re-key (M1-17c) invalidates every other device's offline blob.

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

Ticket M2-10 prompt guidance: "Implement detection for `input[type=password]` plus the nearest preceding text/email input in the same form; fall back to heuristics (name/id/autocomplete attributes). Never fill unless `location.origin` host matches the item's saved host exactly or as a registrable-domain match via `tldts`. Show a warning banner and refuse to fill if the host contains `xn--`." Add `tldts` as the only new dependency.

---

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
