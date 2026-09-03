# Security Policy

## Reporting Security Vulnerabilities

CypherKey takes the security and privacy of our users and their data seriously. We welcome reports from security researchers and the community.

### Reporting Process

- If you discover a security vulnerability or potential threat in CypherKey (client, server, or cryptographic implementation), please send an email directly to:
  **security@cypherkey.io**
- Please include as much detail as possible in your report:
  - A description of the vulnerability.
  - Affected components and versions (e.g. `core/crypto`, `server`, web demo, or browser extension).
  - Step-by-step instructions or proof-of-concept code to reproduce the issue.
  - An assessment of the exploitability and impact.

### Policy & Coordinated Disclosure

- **Response Window:** We acknowledge receipt of vulnerability reports within 48 hours.
- **Disclosure Timeline:** We observe a **90-day coordinated disclosure policy**. Please give us 90 days from the initial report to investigate, patch, and release fixes before publicly disclosing any details.
- **Bug Bounty:** CypherKey is currently an early-stage, solo-founded open-source project. There is **no cash bug bounty program** at this time, but we publicly credit and thank researchers who follow responsible disclosure in our release notes and Hall of Fame.

### Scope

In scope:
- Client zero-knowledge key isolation and cryptographic routines in `core/crypto`.
- Typing dynamics data confidentiality and compliance with data minimization (ensuring raw timing/vectors are never persisted or leaked).
- Server authentication, token rotation, rate limiting, and access control endpoints.
- Browser extension memory handling, isolation, and domain-bound autofill.

Out of scope:
- Attacker with full control of the client OS (e.g. kernel keyloggers, physical memory dump of unlocked machine).
- Social engineering attacks against individual users.
- Denial of Service against testing infrastructure.
