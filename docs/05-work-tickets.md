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

> Note: M0-02's feature-vector spec was superseded — the vector is `3n + 7` with seven globals and no count-based globals. See docs/02 A-4.2, owned by M1-16.

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

### M1-07 · `core/client/session.ts` — the client state machine · L · deps: M1-03..06 · refs A-5
Pure TS, no DOM: `signup()`, `login()`, `stepUp()`, `lock()`, `unlockOffline()`, with an injected `fetch` and `storage` interface. Holds `vaultKey` in memory; `lock()` zero-fills. Tests with a mocked server: full sequence from A-5 login flow.

### M1-08 · Server `/auth/salt`, `/auth/signup` · M · deps: M1-02, M1-05
Validate with Zod; store Argon2id(authHash) via `Bun.password`; generate `server_share`; store `consent_at` and `consent_policy_version` from the request; register device pub key; **return `serverShare` in the 201** (A-5 signup handshake). A second call registers `recoveryWrappedVaultKey`, which wraps the full `vaultKey`; enrollment is refused until it exists. Tests: duplicate username 409; salt fetch for unknown user returns a deterministic fake salt (prevents user enumeration) — HMAC(username, server secret).

### M1-09 · Server `/auth/login` with scoring and bands · L · deps: M1-08, M0-03 · refs A-4.4, A-5
Verify authHash → device sig → nonce/ts → score → band → tokens or stepUp. 500 ms floor. Score row written; feature vector **never** persisted (test asserts DB contains no vector). Lockout after 5 fails. Tests: pass/grey/fail/new-device/lockout/replayed nonce.

### M1-10 · Server `/enroll/*` · M · deps: M1-08 · refs A-4.3
Sample upload (requires enrollment-scoped token issued at signup), build at N samples, delete samples after build. Tests: builds at exactly N; samples table empty after; rejects vector whose length is not `3·script_len + 7`.

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
**Changes:** `KeyEvent` gains `{ type: 'blur' }`. `startCapture` records Backspace/Delete/Escape (Escape with `preventDefault`), detects lone modifier taps (down/up with no other keydown in between) as tokens, marks Ctrl/Alt/Meta chords, listens for `blur`, and cancels on Tab/Enter-as-non-terminator/arrows/nav keys/`paste`/`drop`/`compositionstart`. `extractFeatures` treats every token as a key and the `backspace` error is removed. **Do not add a `backspaceCount` global** — the earlier instruction to keep it at weight 0 was wrong and is withdrawn: a count of Backspace tokens tells the server how many backspaces are in the script, which breaks A-14's guarantee that only the script *length* leaks. The vector stays at `3n + 7` with the seven globals M0 shipped, `n` = script token count (docs/02 A-4.2).
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
**Tests:** (1) identical → 0 ins / 0 del, ops all match; (2) one extra `x⌫` pair → 2 insertions, **passes** at Medium (`maxInsertions` = 2 at n=10); (3) login missing one canonical token → 1 deletion → 401 at Medium (`maxMissing` = 0) and the lockout counter increments; (3b) login with the resolved passphrase only, against a two-phantom canonical → 2 deletions → 401 at Medium **and** at Relaxed; (4) 13-token login vs 12-token profile with one insertion scores within **0.02** of the same rhythm at 12 tokens (bridging, not neutralizing, is what buys this); (4b) a deletion under Relaxed scores within **0.06**; (5) no commitment, token, or vector appears in logs (assert log capture).
**Acceptance:** e2e: enroll with 2 phantoms on Medium; login with one lone-Escape slip passes; login with resolved passphrase only (missing both phantoms) fails; wrong passphrase fails before alignment runs (timing-padded).

### M1-17c · Strictness setting endpoint and Strict re-key flow · M · deps: M1-17b, M1-13
`PATCH /user/settings {strictness}` requires step-up flag; server updates thresholds. Client `session.changeStrictness(level)`: if crossing into/out of Strict, re-derive `masterKey`, re-wrap `vaultKey`, re-register `authHash`, re-send commitments, revoke other devices' cached keys (bump `key_version`). Tests: medium→relaxed touches no keys; medium→strict rotates and old authHash no longer works.

### M1-18 · Update the web demo for Phantom Keys · S · deps: M1-16
`site/demo.ts`: allow Backspace during enrollment; add a "Try Phantom Keys" toggle with the explanation copy from A-14; show token count vs character count ("12 keystrokes · 8 characters"). Keep client-only.

### M1-19 · Build pipeline and size budgets · M · deps: M1-15 · refs A-15
`bun build --compile` for the server, multi-stage distroless Dockerfile, `scripts/size-check.ts` with the A-15 budgets, CI step that fails on regression and posts sizes. Tests: the script itself has a unit test with a fixture over/under budget.

---

# M2 — Extension and Private Beta

Use **WXT** (MV3, Chrome + Firefox, React + TypeScript). One ticket per screen or subsystem.

| ID | Title | Size | Notes |
|---|---|---|---|
| M2-01 | WXT scaffold, popup/options/background/content scripts, Tailwind, storage abstraction implementing `core/client` storage interface | M | |
| M2-02 | `<RhythmLight/>` React component wrapping `startCapture`; pulse, bands, tooltip, ARIA | M | X-1 |
| M2-03 | Onboarding: passphrase + zxcvbn + generator | M | X-2 |
| M2-04 | Recovery Kit screen with "type 4 chars back" confirmation; printable view | M | X-2, M1-06 |
| M2-05 | Enrollment screen: 8 samples, ring, backspace retry | M | |
| M2-06 | In-app Party Trick screen (post-enrollment, one-time) | S | X-7 |
| M2-07 | Unlock screen: login flow, bands, grey retype, step-up with recovery codes | L | X-3 |
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

**M3:** adaptive thresholds (per-user pass/grey from score history percentiles), per-device profiles, passkey and TOTP step-up (`@simplewebauthn`, `otpauth`), Rhythm Signature view, Precision Mode flag, Firefox build, docs site (Astro Starlight), SECURITY review fixes, launch checklist.
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
