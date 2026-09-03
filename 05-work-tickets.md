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

# M0 — Demo Day (Sept 14)

### M0-01 · Repo hygiene and naming · S · deps: none
**Files:** modify README.md, package.json, all files containing `CipherKey`/`CIPHERKEY`; create `docs/02-architecture-and-threat-model.md`, `docs/03-experience-design.md` (copied from this package), `AGENTS.md`, `SECURITY.md`, `LICENSE-SERVER` (AGPL), `LICENSE-CLIENT` (MIT).
**Acceptance:** `grep -ri cipherkey .` returns nothing outside `CHANGELOG.md`. README first screen: one-liner, origin story (3 sentences), "How it's safe" (5 bullets from A-11), architecture ASCII diagram, license table, roadmap table.
**Prompt:**
```
Ticket M0-01. Rename every occurrence of CipherKey/CIPHERKEY/cipherkey to CypherKey/CYPHERKEY/cypherkey across the repo (case-preserving). Rewrite README.md using the structure in docs/00-README-structure.txt [paste the Acceptance bullets here]. Add SECURITY.md with a responsible-disclosure policy (email security@cypherkey.io, 90-day disclosure, no bounty yet). Add AGENTS.md from the provided text. Do not change any TypeScript logic.
```

### M0-02 · Extract pure feature extraction into `core/biometrics/features.ts` · M · deps: M0-01 · refs A-4.2
**Files:** create `core/biometrics/features.ts`, `core/biometrics/types.ts`, `core/biometrics/features.test.ts`; modify existing extraction call sites to import from core. DO NOT TOUCH: server, extension UI.
**Interfaces:**
```ts
export type KeyEvent = { key: string; type: 'down' | 'up'; t: number }; // t = performance.now()
export type FeatureVector = { version: 1; len: number; values: number[] }; // length 3*len+5, order per A-4.2
export function extractFeatures(events: KeyEvent[], expectedLen: number): FeatureVector | { error: 'backspace' | 'length_mismatch' | 'malformed' };
```
**Tests:** `features.test.ts`: (1) a synthetic 6-key sequence yields length 23 with known dwell/flight/digraph values; (2) any Backspace event → `{error:'backspace'}`; (3) unmatched down/up → `malformed`; (4) wrong key count → `length_mismatch`; (5) deterministic output for identical input.
**Acceptance:** tests pass; no DOM imports in `core/`.
**Prompt:**
```
Ticket M0-02. Create core/biometrics/features.ts implementing extractFeatures with exactly this signature: [paste]. Feature order: dwell[0..len-1], flight[0..len-2], digraph[0..len-2], then globals [totalTime, meanDwell, stdDwell, meanFlight, stdFlight]. Use population std dev. Reject on Backspace, malformed pairing, or length mismatch as specified. No browser APIs in this file. Write core/biometrics/features.test.ts with the five cases listed, then implement.
```

### M0-03 · Local profile build + scoring in `core/biometrics/score.ts` · M · deps: M0-02 · refs A-4.3–A-4.4
**Interfaces:**
```ts
export type Profile = { version: 1; len: number; means: number[]; stds: number[]; weights: number[]; sampleCount: number };
export function buildProfile(samples: FeatureVector[]): Profile;   // stds floored at 8 (ms)
export function score(profile: Profile, sample: FeatureVector): number; // 0..1 per A-4.4, k=2.0
export function band(s: number, pass = 0.62, grey = 0.45): 'pass' | 'grey' | 'fail';
export function adapt(profile: Profile, sample: FeatureVector, alpha = 0.1): Profile;
```
**Tests:** `score.test.ts`: (1) a sample equal to the means scores ≥ 0.99; (2) a sample 3 std away on all features scores < 0.35; (3) `band` thresholds; (4) `adapt` moves means by exactly alpha*(x−mean); (5) profile from 8 near-identical samples has all stds == 8.
**Acceptance:** tests pass. Weights: dwell 1.0, flight 1.5, digraph 1.0, globals 0.5.
**Prompt:**
```
Ticket M0-03. Implement core/biometrics/score.ts with these exact exports: [paste]. Scoring: z = |x-mean|/std; featureScore = 1/(1+(z/2)^2); score = weighted mean with weights dwell 1.0, flight 1.5, digraph 1.0, globals 0.5 (feature index ranges follow features.ts). Write score.test.ts with the five cases first.
```

### M0-04 · Rhythm Light capture module · M · deps: M0-02 · refs X-1
**Files:** create `core/biometrics/capture.ts`, `core/biometrics/capture.test.ts` (happy-dom).
**Interfaces:**
```ts
export function startCapture(input: HTMLInputElement, light: HTMLElement, opts?: { onPulse?: () => void }): { stop(): KeyEvent[]; cancel(): void };
// throws Error('RhythmLightNotVisible') if light is not in document or has display:none/visibility:hidden/opacity 0
```
**Tests:** throws when light hidden; records down/up pairs with performance.now; `onPulse` fires per keydown; `stop()` removes listeners; ignores modifier-only keys (Shift, Ctrl, Alt, Meta) but records Backspace.
**Prompt:**
```
Ticket M0-04. Implement core/biometrics/capture.ts: [paste signature and rules]. Visibility check must use getComputedStyle and isConnected. Add `happy-dom` as a dev dependency for tests only. Write capture.test.ts first.
```

### M0-05 · The web demo (static, client-only) · L · deps: M0-03, M0-04 · refs X-2 step 5, 09
**Files:** create `site/` (Vite + vanilla TS + Tailwind), `site/index.html`, `site/demo.ts`, `site/styles.css`. DO NOT TOUCH `core/` except imports.
**Spec:**
- Sections: hero (one-liner + "Try it" button), demo, "How it works" (3 steps), "How it's safe" (5 bullets), origin story, roadmap, GitHub + email capture (Buttondown or a Formspree endpoint — env var).
- Demo state machine: `idle → enrolling(1..8) → built → challenge(friend) → challenge(you) → results`. Passphrase chosen by the user (min 10 chars) or "use a sample phrase." Rhythm Light dot pulses per keystroke; progress ring 0–8. Reset button.
- Results show both scores as big numbers with band colors and the sentence "Same passphrase. Different rhythm."
- Nothing leaves the browser; state a "runs entirely in your browser — nothing is sent anywhere" line under the demo and make it true (no analytics on the demo page except a privacy-respecting pageview if any).
- Mobile layout works but shows "Best experienced on a physical keyboard."
**Acceptance:** `bun run build:site` outputs `site/dist`; Lighthouse performance > 90; demo works in Chrome, Safari, Firefox; you pass and a stranger fails ≥ 4/5.
**Prompt:**
```
Ticket M0-05. Build site/ with Vite (vanilla-ts template) and Tailwind. Implement index.html and demo.ts per this spec: [paste Spec]. Import extractFeatures/buildProfile/score/band/startCapture from ../core. Keep all logic client-side. Use the copy in docs/09 for hero and origin story. Provide `bun run dev:site` and `bun run build:site` scripts.
```

### M0-06 · Deploy site to Cloudflare Pages + domain · S · deps: M0-05
**Acceptance:** cypherkey.io serves the site over HTTPS; `www` redirects; a `_headers` file sets CSP (`default-src 'self'`), HSTS, and no-referrer. Do this yourself in the Cloudflare dashboard; the model only produces `_headers` and the build config.

### M0-07 · One-pager and demo assets · S · deps: none
Use file 09. Export the one-pager to PDF (Google Docs is fine). Record a 45-second screen video of the demo as a backup in case wifi fails.

---

# M1 — Foundation Rewrite

### M1-01 · Server skeleton: Hono + Drizzle + config · M · refs A-8, A-13
**Files:** create `server/src/app.ts`, `server/src/config.ts`, `server/src/db/{schema.ts,client.ts}`, `server/drizzle.config.ts`, `server/src/routes/health.ts`, tests. Remove `ENCRYPTION_KEY`, in-memory revocation, `credentials`, `enroll_tokens`.
**Spec:** `config.ts` loads env with Zod; **exits with a clear message if `JWT_SECRET` < 32 bytes**. `DATABASE_URL` selects `bun:sqlite` or `postgres`. `GET /healthz` → `{ok:true, db:'sqlite'|'postgres'}`.
**Tests:** config rejects missing secret; healthz 200 on both drivers (Postgres via `DATABASE_URL` in CI service).
**Prompt:** `Ticket M1-01. Replace the existing server entry with a Hono app… [paste Spec]. Add dependencies: hono, drizzle-orm, drizzle-kit, postgres, zod. Do not port old routes yet.`

### M1-02 · Schema and migrations · M · deps: M1-01 · refs A-9
All tables from A-9 in Drizzle with both dialects. `bun run db:migrate`. Test: migrate on fresh SQLite and Postgres; insert/select a user.

### M1-03 · `core/crypto/kdf.ts` — Argon2id + HKDF · M · refs A-2
```ts
export async function deriveMasterKey(passphrase: string, salt: Uint8Array, params?: ArgonParams): Promise<Uint8Array>; // 32B
export async function deriveSubkey(masterKey: Uint8Array, info: 'cypherkey/auth/v1' | 'cypherkey/wrap/v1'): Promise<Uint8Array>;
export function randomBytes(n: number): Uint8Array;
```
Use `@noble/hashes` (argon2id, hkdf). Tests: known-answer vectors (generate once with a reference implementation and commit them); different salts → different keys; subkeys differ by info.

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
Validate with Zod; store Argon2id(authHash) via `Bun.password`; generate `server_share`; register device pub key; return 201. Tests: duplicate username 409; salt fetch for unknown user returns a deterministic fake salt (prevents user enumeration) — HMAC(username, server secret).

### M1-09 · Server `/auth/login` with scoring and bands · L · deps: M1-08, M0-03 · refs A-4.4, A-5
Verify authHash → device sig → nonce/ts → score → band → tokens or stepUp. 500 ms floor. Score row written; feature vector **never** persisted (test asserts DB contains no vector). Lockout after 5 fails. Tests: pass/grey/fail/new-device/lockout/replayed nonce.

### M1-10 · Server `/enroll/*` · M · deps: M1-08 · refs A-4.3
Sample upload (requires enrollment-scoped token issued at signup), build at N samples, delete samples after build. Tests: builds at exactly N; samples table empty after; rejects vector with wrong length.

### M1-11 · Refresh tokens, logout, device list/revoke · M · deps: M1-09
Rotating refresh tokens hashed in DB; reuse of a rotated token revokes the family. Tests: rotation; reuse → all revoked.

### M1-12 · Server `/vault/changes` · M · deps: M1-09 · refs A-6
Cursor-based get; batch upsert with version check → 409 with server copy on conflict. Tests: two "devices" write same item; second gets 409 and server value.

### M1-13 · Server `/user/settings`, `/user/rhythm` · S · deps: M1-09
Settings PATCH requires a fresh step-up flag on the token for `biometricEnabled=false` or `pauseUntil`.

### M1-14 · Rate limiting + audit log middleware · M · deps: M1-09
Token bucket per IP (100/min) and per account (10 logins/min) in DB; `audit_log` writes for auth events; IPs stored as salted hash.

### M1-15 · Docker + compose + CI · M · deps: all M1
`Dockerfile` (bun, non-root), `docker-compose.yml` (server + volume; optional Postgres profile), GitHub Actions: test on SQLite and Postgres service, typecheck, lint, `bun audit`. **Exit test for M1:** `scripts/e2e.ts` runs the full sequence from file 04.

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
| M2-14 | Settings: devices list/revoke, biometric toggle, Pause (step-up gated) | M | X-4 |
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
