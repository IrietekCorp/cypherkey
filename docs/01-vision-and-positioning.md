# 01 — Vision and Positioning

## One-liner

**CypherKey is the open-source password manager where your password always works when *you* type it.**

Secondary: *A zero-knowledge vault with a built-in behavioral second factor — no phone, no code, no dongle. Just type.*

## The origin story (use it everywhere)

In 2010 at CBSSports.com you built "KeyStroke Captcha" — first to tell humans from bots by how they typed, then to protect passwords. You told teammates your password and watched them fail to log in; then you sat down and got in on the first try. Sixteen years later, the average person has ~120 passwords, credential abuse still appears in roughly 39% of breaches, and the "your password was found on the dark web" email is a routine part of life. The signal you demonstrated in 2010 is present on every login today. CypherKey makes it count.

That story does three things: proves the idea is yours, makes it demonstrable in 30 seconds, and gives journalists a narrative.

## The wedge (first 1,000 users)

Two audiences, one product, strict ordering:

1. **Privacy-minded technical people (HN, r/privacy, r/selfhosted, r/Bitwarden refugees).** They evaluate on: open-source, zero-knowledge, self-hostable, honest threat model, no dark patterns. They will find any dishonesty in an hour and reward honesty with stars and installs.
2. **Toil-fatigued consumers** who are sick of authenticator apps, SMS codes, hardware keys, and passkey prompts on six devices. They evaluate on: "does it just work," and "does the scary email stop scaring me."

Enterprise/IdP (Keycloak-for-biometrics) is the destination, not the start. Everything that makes it enterprise-grade (zero-knowledge, audit logs, self-host parity, adaptive thresholds) is built in service of audience 1 first.

## Personas

| Persona | Trigger | Wins if | Loses if |
|---|---|---|---|
| **Sam, senior dev, self-hoster** | Saw the HN post, wants to read the crypto doc before installing | Threat model is honest; `docker compose up` works; AGPL server, MIT client | Any "trust us" hand-waving; biometric data leaves their box |
| **Priya, consultant, 140 passwords** | Got the dark-web email again | Setup < 3 min; stops worrying; extension autofill is flawless | Locked out once while traveling; a single autofill bug |
| **Marcus, CS gamer, Hall-effect keyboard** | "My typing is a fingerprint" resonates | Precision Mode lets him tighten the threshold; visual rhythm signature | Profile breaks when he switches keyboards |
| **Dana, founder of a 12-person SaaS** (later) | Wants 2FA without forcing users onto an app | Drops in the SDK, users are pre-enrolled, flips the switch | Legal ambiguity around biometric consent |

## The honest claim (and why it wins)

What keystroke dynamics *is*: a behavioral biometric. Fixed-text academic results range widely — one 2024 dataset reported equal error rates of roughly 10–18% depending on the password, while tuned models on the CMU benchmark report EERs in the single digits or below 1%. Real-world drift (fatigue, injury, new keyboard, session-to-session change) pushes numbers toward the worse end.

What that means for positioning:

- **We say:** "A stolen password alone won't log in as you." (True: the attacker doesn't have your rhythm.)
- **We say:** "Zero extra steps. No phone, no code." (True and the core differentiator.)
- **We say:** "Complements passkeys — store them here, gate them with your rhythm." (Ally, not enemy.)
- **We never say:** "unhackable," "replaces MFA for everything," "biometric-grade like Face ID."
- **We disclose:** the threshold is probabilistic; a determined attacker watching you type could approximate it; that's why there's a device trust layer and step-up factors behind it.

Security people respect a product that names its own limits. That respect converts to stars, which converts to distribution.

## Positioning matrix

| Method | Phishing-resistant | Replay-resistant | Extra device/step | Works with existing passwords | Offline | Open-source option | Recovery story |
|---|---|---|---|---|---|---|---|
| Password only | No | No | None | — | Yes | — | Email reset |
| SMS OTP | No | Partial | Phone + code | Yes | No | No | SIM swap risk |
| TOTP app | No | Yes | Phone + code | Yes | Yes | Yes | Backup codes |
| Push (Duo etc.) | Partial | Yes | Phone tap (fatigue attacks) | Yes | No | Rarely | Vendor |
| Hardware key | Yes | Yes | Carry a device | Yes | Yes | Some | Buy two keys |
| Passkeys | Yes | Yes | Device biometric prompt; sync across ecosystems is the pain | No (replaces) | Yes | Yes | Platform-bound |
| Behavioral biometrics vendors (TypingDNA, BioCatch) | No | Yes | None | Yes (as add-on) | No | No | Vendor |
| Password managers (Bitwarden, 1Password, Proton) | Partial (domain matching) | No | Master password + optional 2FA | Yes | Yes | Bitwarden/KeePass | Recovery kit / emergency access |
| **CypherKey** | Partial (domain matching, like PMs) | **Yes** | **None** | **Yes** | **Yes (cached device)** | **Yes** | **Recovery Kit + step-up ladder** |

**Where CypherKey is uniquely positioned:** the only cell that is simultaneously *zero extra steps*, *replay-resistant*, *works with the passwords you already have*, *open source*, and *a real vault*. No one else occupies that cell.

**Where CypherKey loses honestly:** phishing resistance vs passkeys/hardware keys. Our answer is domain-bound autofill (never fill on a lookalike domain) plus passkey storage — the same answer Bitwarden and 1Password give.

## Competitive landscape

**Behavioral biometrics vendors**
- **TypingDNA** — closest in concept. Sells "Verify 2FA" (type four words in a popup instead of an OTP) and an authentication API, integrates with Entra ID, Okta, Ping, Keycloak; pricing is per-verification/subscription, closed source, B2B only, demo requires a sales call. They validate the category. Our differences: open source, self-hostable, consumer-first, a real password vault, no vendor holding biometric templates.
- **BioCatch, BehavioSec (LexisNexis), Plurilock** — enterprise fraud/continuous-auth. Not consumer, not open, not vaults.

**Password managers**
- **Bitwarden** — open-source, zero-knowledge, cheap. Our biggest overlap and the standard we must match on vault quality. Differentiator: they have no behavioral factor; their 2FA is TOTP/keys.
- **1Password / Proton Pass / Dashlane / NordPass** — polished, closed (Proton partially open), none have typing biometrics.
- **KeePassXC** — local-first purists. Our self-host story speaks to them.
- **Browser/OS managers (Google, Apple)** — the real default for most people. We are not trying to beat them at "free and built in"; we are the upgrade for people who've been burned.

**Passkeys** — an ally. Strategy: store passkeys in the vault (Phase 4), and offer "rhythm-gated passkey release" as a unique feature: the passkey is only used if your typing matches.

## Messaging pillars

0. **"Your password is passw0rd. Your login is passsss⌫⌫w0rd."** Phantom Keys: extra keystrokes you delete become part of your secret. A password leaked from anywhere else doesn't contain them.

1. **"Type it like you mean it."** Your rhythm is the second factor. Nothing to carry.
2. **"The dark-web email stops being scary."** A leaked password is not a leaked login.
3. **"We can't read your vault. Nobody can."** Zero-knowledge, open source, self-host in one command.
4. **"You'll always see the light."** The Rhythm Light shows exactly when we're listening. Consent is a feature.
5. **"Works with every password you already have."** No migration of the internet required.

## Naming

Use **CypherKey** everywhere (matches cypherkey.io). Product nouns: **the Vault**, **your Rhythm** (the biometric profile), **the Rhythm Light** (capture indicator), **Recovery Kit**, **Pause** (temporary biometric off), **Precision Mode** (stricter threshold for power users).

## Pricing (launch)

| Tier | Price | Includes |
|---|---|---|
| **Free** | $0 | Unlimited vault items, rhythm auth, 2 devices, self-host anything |
| **Pro** | $3/mo or $30/yr | Unlimited devices, breach monitoring, emergency access, priority sync, Precision Mode |
| **Family** | $5/mo (5 users) | Shared collections |
| **Teams** | $4/user/mo | Admin console, SSO later, audit log |
| **SDK / IdP** | Free ≤1k MAU, then usage-based | Progressive Enrollment, hosted scoring, dashboards |

Bitwarden Premium is ~$10/yr; NordPass Premium starts around $1.59/mo. We are priced above Bitwarden because we ship a factor they don't have. Do not compete on price with Bitwarden; compete on "no phone needed."

Target for the sober viral definition (100 paid, 1,000 free): roughly 10% conversion at $30/yr is $3,000 ARR — irrelevant as revenue, meaningful as proof of willingness to pay for the pitch deck.
