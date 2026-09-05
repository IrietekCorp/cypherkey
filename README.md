# CypherKey

> **CypherKey is the open-source password manager where your password only works when *you* type it.**
> 
> *A zero-knowledge vault with a built-in behavioral second factor — no phone, no code, no dongle. Just type.*

---

## Origin Story

In 2010 at CBSSports.com, I built "KeyStroke Captcha" — first to distinguish humans from bots by how they typed, and then pointed it at passwords to discover teammates couldn't log in with my credentials, but I could on the first try. Sixteen years later, the average person manages ~120 passwords, credential stuffing accounts for roughly 39% of breaches, and "your password was leaked" alert emails have become a wearying routine of modern life. The typing rhythm signal that existed in 2010 is present on every single login today; CypherKey turns that signal into an effortless, unforgeable defense.

---

## How It's Safe

CypherKey is engineered with strict cryptographic isolation and privacy-preserving biometric mathematics:

1. **Zero-Knowledge Architecture:** The server stores only `Argon2id(authHash)` and wrapped ciphertext blobs. The server never sees your plaintext vault, master key, wrap key, or passphrase, and cannot decrypt your data.
2. **Typing Rhythm as a Frictionless Second Factor:** Stolen or leaked passwords alone cannot unlock the vault without matching your unique keystroke rhythm (dwell times, flight times, and digraph transitions).
3. **Data Minimization by Design:** Raw keystroke events and high-dimensional feature vectors are **never stored or logged**, either on the client or server. Only irreversible statistical aggregates (means, floored standard deviations, and weights) and scalar score results are kept.
4. **The Rhythm Light Guarantee:** No keystroke timing is ever captured without a visible indicator. Code-level enforcement throws an exception if the Rhythm Light element is missing or hidden, guaranteeing transparent user consent.
5. **No Lockout by Your Own Hands:** A resilient graceful degradation ladder (Pass, Grey-band retype, Step-up via passkey/TOTP/Recovery Kit, and Pause mode) ensures injury, fatigue, or travel never locks you out of your vault.

---

## Architecture Overview

```
Client (Extension / Site / CLI)                        Server (Hono + Drizzle)
────────────────────────────────                       ───────────────────────
Passphrase (in user memory)
   │
   ▼ Argon2id(passphrase, userSalt)
MasterKey (32B, client memory only)
   ├── HKDF("cypherkey/auth/v1") ── authHash ───────► Verify Argon2id(authHash)
   │                                                    │
   │   [Rhythm Light Active]                            ▼
   └── Keystroke Dynamics ─────── featureVector ─────► Score vs Profile (A-4.4)
                                                        │
                                                        ├── Pass (≥0.62)
                                                        ├── Grey (0.45..0.62)
                                                        └── Fail (<0.45)
                                                        │
   ┌── AES-GCM unwrap ◄────────── serverShare ──────────┘ (Released on Pass/Step-up)
   │         ▲
   ▼         │
vaultKey = wrapKeyUnwrap(wrappedVaultKey) XOR serverShare
   │
   ▼ AES-256-GCM
Decrypted Vault Items
```

---

## Licensing

CypherKey uses a clean dual-license split:

| Component | License | Details |
|---|---|---|
| **Core Client (`core/`), Web Demo (`site/`), Extension (`extension/`), SDK** | **MIT** | Free and open for embedding, extensions, and client tooling. See [`LICENSE-CLIENT`](file:///home/shawn/Development/cypherkey/LICENSE-CLIENT). |
| **Sync & Auth Server (`server/`)** | **AGPL-3.0** | Copyleft network license ensuring self-hosters and service operators contribute back. See [`LICENSE-SERVER`](file:///home/shawn/Development/cypherkey/LICENSE-SERVER). |

---

## Roadmap

| Milestone | Target Date | Scope & Headline |
|---|---|---|
| **M0** | Sep 14, 2026 | **Demo Day**: Live in-browser demo at cypherkey.io, clean repo, zero-knowledge docs, one-pager. |
| **M1** | Oct 20, 2026 | **Foundation Rewrite**: Zero-knowledge core (`core/crypto`), Hono + Drizzle server, one-command self-host. |
| **M2** | Dec 5, 2026 | **Extension & Private Beta**: Chrome MV3 WXT extension, Rhythm Light, autofill, 25 beta users. |
| **M3** | Jan 20, 2027 | **Public Launch**: Adaptive thresholds, Passkey/TOTP step-up, Pause mode, external security audit. |
| **M4** | Mar 31, 2027 | **Revenue & Reach**: Stripe billing, breach monitoring, native CLI with terminal raw-mode capture. |
| **M5** | Jun 30, 2027 | **SDK & Progressive Enrollment**: `@cypherkey/sdk`, service dashboard, Teams tier. |
| **M6** | Sep 30, 2027 | **IdP & Mobile**: OIDC provider, mobile read-only vault. |

---

## Development & Verification

Requirements: [Bun](https://bun.sh) 1.x.

```bash
# Install dependencies
bun install

# Run test suite
bun test

# Typecheck codebase
bun run typecheck

# Lint and format
bun run lint

# Run in-browser demo locally
bun run dev:site

# Build static site for production (deployed to GCP; see M2-16)
bun run build:site
```

See [`docs/02-architecture-and-threat-model.md`](file:///home/shawn/Development/cypherkey/docs/02-architecture-and-threat-model.md) and [`docs/03-experience-design.md`](file:///home/shawn/Development/cypherkey/docs/03-experience-design.md) for detailed technical specifications.
