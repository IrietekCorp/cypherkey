# CypherKey — Executive One-Pager

**The open-source password manager where your password always works when *you* type it.**  
*Web:* [cypherkey.io](https://cypherkey.io) · *Repository:* [github.com/IrietekCorp/cypherkey](https://github.com/IrietekCorp/cypherkey) · *Contact:* hello@cypherkey.io

---

### Problem
People juggle **~120 passwords**, and the vast majority are reused across personal and work services. Credential abuse still appears in **~39% of all breaches** — the single most pervasive attack vector across enterprise and consumer domains. Every existing fix adds friction: SMS codes, authenticator apps, physical hardware dongles, and fragmented passkeys that fail to sync cleanly across operating systems and browser ecosystems.

### Product
A **zero-knowledge vault** (the server cannot read your data, ever) combined with a **behavioral second factor** derived from the sub-millisecond dynamics of typing your passphrase (dwell times, flight times, digraph rhythms).
- **No phone, no code, no dongle.** Just type.
- **Works with every password you already have.** No migration of the internet required.
- **Open-source dual license:** AGPL-3.0 server for community self-hosting with a single command (`docker compose up`); MIT-licensed client modules, extension, and SDK.
- **Hosted tier** for users and teams wanting turnkey sync and infrastructure.

### Why It's Different
CypherKey is the only solution positioned at the intersection of:
1. **Zero extra steps:** Authentic second factor with zero friction.
2. **Replay-resistant:** Key derivation and signed challenges bound to cryptographic device keys.
3. **Open source & Zero-Knowledge:** Transparent cryptographic verification; no proprietary black boxes.
4. **Consent as a Feature:** The **Rhythm Light** provides visible, code-enforced assurance of whenever timing is measured.
5. **Human-centered Fallbacks:** Multi-tier degradation ladder (pass, grey-band retry, passkey/TOTP step-up, pause mode) guarantees you are never locked out by fatigue or injury.

### Why Now
Behavioral biometrics is an established, validated enterprise category (used by major financial institutions and state DMVs), but has been locked behind closed-source, high-friction, enterprise-only contracts. Passkeys are gaining ground on ~48 of the top 100 websites, but passwords will guard the remaining majority, legacy software, routers, and internal infrastructure for decades to come. CypherKey protects those passwords today and natively stores passkeys too.

### Business Model
- **Free:** 2 devices, unlimited items, self-host all components.
- **Pro ($3/mo or $30/yr):** Unlimited devices, breach alerts, emergency access, priority sync, Precision Mode.
- **Family ($5/mo):** 5 members, shared vaults.
- **Teams ($4/user/mo):** Central admin, audit logs, shared collections.
- **B2B SDK / Progressive Enrollment:** Free up to 1k MAU, usage-based tiers for sites seeking passive biometric enrollment.

### Traction & Milestones
- **M0 (Sept 14, 2026):** Live browser demo at cypherkey.io; public repo launch.
- **M1 (Oct 20, 2026):** Zero-knowledge cryptographic core & Hono/Drizzle server.
- **M2 (Dec 5, 2026):** Chrome MV3 extension; 25-user private beta.
- **M3 (Jan 20, 2027):** Public launch (Hacker News / Product Hunt); target: 5,000 GitHub stars, 1,000 active users.
- **M4 (Mar 31, 2027):** Paid Pro tier live; native CLI; target: 100 paying customers.

### The Creator
**Shawn J. Stewart** — President, Irietek Corporation; technical executive and venture builder with 25+ years scaling global engineering organizations. Previously Apartment List, Gusto, LinkedIn, Ultimate Software and Fidelity Investments. Built the first working keystroke dynamics prototype at **CBSSports.com in 2010** ("KeyStroke Captcha"); CypherKey is that idea with a sixteen-year head start, built at Irietek with modern AI agentic tooling.

[piscopour.com](https://piscopour.com) · [linkedin.com/in/irietek](https://www.linkedin.com/in/irietek) · [github.com/irietek](https://github.com/irietek)

### What Would Help
- **Investors:** introductions in cybersecurity and developer tools, and candid feedback on the model.
- **Engineers and designers:** the codebase is open — cryptography review, extension work and design contributions are all welcome.
- **Prospective users:** a seat in the private beta, and an honest verdict on whether the browser demo convinces you.
