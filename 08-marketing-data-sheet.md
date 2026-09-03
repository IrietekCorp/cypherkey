# 08 — Marketing Data Sheet

Every figure below was checked against a source on September 3, 2026. Re-verify before print. Where a figure comes from a secondary summary rather than the primary report, it's marked **(secondary)** — confirm against the primary before using it in a deck.

## The problem: passwords are everywhere and they leak

| Stat | Source | Use it for |
|---|---|---|
| The average person manages **~120 passwords** (2025), down from a peak of 168 in 2024 and up from ~80 in 2020 | NordPass, "How many passwords does the average person have" | Scale of the toil |
| **84%** of U.S. adults do not use a unique password for every account; **65%** use predictable patterns or personal info | PasswordManager.com survey, Jan 2026 (n=1,500) | Why a stolen password is a master key |
| **68%** of Americans reuse the same password across multiple accounts | Security.org password-habits survey (2026 review) | Reuse |
| **61%** of U.S. consumers reuse passwords; only 39% use a unique one everywhere | GoDaddy Consumer Pulse 2025 (via Enzoic) **(secondary)** | Reuse, alternative source |
| **49%** don't change passwords because they fear forgetting; **40%** say it's inconvenient | PasswordManager.com, Jan 2026 | The "toil" narrative |
| **38%** of Americans have had at least one password guessed or cracked; **25%** store passwords in unencrypted notes | Security.org | Personal risk |
| Only **36%** of U.S. adults (~94M) use a password manager, up from 34% the prior year | Security.org 2026 (widely cited) | Market headroom |
| Password-manager users report credential/identity theft at **17% vs 32%** for non-users | Security.org 2026 **(secondary summary)** | PMs work |
| Data compromises hit **3,158 in 2024**, near the 2023 record | Identity Theft Resource Center (via Security.org) | Breach volume |
| FBI reported **$16.6B** in cybercrime losses in 2024 | FBI IC3 (via Security.org) | Cost |

**About the "79% log in every day" figure:** I could not locate a NordPass primary source for that number. Don't use it on a slide until you find the original page; the 120-passwords figure from NordPass is verifiable and does similar work.

## The breach data: credentials still run the show

| Stat | Source |
|---|---|
| In the **2026 Verizon DBIR** (22,000+ confirmed breaches, 145 countries), vulnerability exploitation became the #1 initial entry point at 31% — the first time in 19 years it passed stolen credentials | Verizon DBIR 2026 announcement |
| But **credential abuse still appears in ~39% of breaches** across the full attack chain — the single most pervasive technique in the dataset | DBIR 2026 (via Push Security, Descope analyses) |
| **73%** of ransomware victims had an infostealer or credential leak in the prior year; half of those within 95 days before the attack | DBIR 2026 (via Descope) |
| Small orgs saw a median of **7** credential-leak events per year; large orgs ~20 | DBIR 2026 (via Descope) |

**Talking point:** "Attackers changed how they get in the door. They haven't changed what they do once inside — they use your passwords. CypherKey makes a leaked password useless without the person who owns it."

## Passkeys: ally, not enemy

| Stat | Source |
|---|---|
| **5 billion** passkeys in use worldwide | FIDO Alliance, State of Passkeys 2026 (May 2026) |
| **90%** awareness; **75%** have enabled a passkey on at least one account; **49%** use them regularly when available | FIDO 2026 (n=11,000 consumers, 10 countries) |
| **68%** of organizations have deployed or are deploying passkeys for employees | FIDO 2026 (n=1,400) |
| **48%** of the top 100 websites support passkeys — more than double 2022 | FIDO (via Descope) |
| **57%** of organizations still rely on phishable authentication for primary sign-in | FIDO 2026 (via MojoAuth summary) **(secondary)** |

**Talking point:** "Passkeys are winning — on 48 of the top 100 sites. Passwords still guard the other 52, plus every internal tool, router, NAS, SSH box, and legacy app on earth. CypherKey protects the passwords that aren't going anywhere, and stores your passkeys too."

## The science (be precise here; the HN crowd will check)

| Claim | Source |
|---|---|
| Fixed-text keystroke dynamics on a new 6-password dataset: EER of **10.2–18.1%** depending on the password with one method; a second method reached 98% true-accept / 90.4% true-reject | Fixed-text keystroke dynamics dataset paper (2024, Annals of Telecommunications) |
| Tuned CNN models on the CMU benchmark report EER as low as **~0.65%** | Keystroke Dynamics with MLP/CNN/LSTM (2024) |
| Cross-session drift is real: a 2026 study shows session-to-session HTER around 0.19 when thresholds are transferred unchanged | Electronics 2026, "Client-Side Continuous Authentication Using Keystroke Dynamics" |
| Timing leaks are old news: keystroke timing over SSH was shown to leak password information in 2001 (Song, Wagner, Tian) | USENIX Security 2001 — cite from memory; link the paper |

**How to say it:** "Academic results range from under 1% to ~15% error depending on method and conditions. We publish our own numbers from real users, and we designed the fallback ladder for the bad days."

## The category exists (validation for VCs)

| Fact | Source |
|---|---|
| TypingDNA sells typing biometrics as 2FA ("type 4 words instead of an OTP"), integrates with Entra ID, Okta, Ping, Keycloak; demo requires a sales call; closed source | typingdna.com |
| TypingDNA claims the NY State DMV and the European Banking Authority accept typing biometrics as a compliant authentication method | typingdna.com (vendor claim — verify EBA text before citing) |
| TypingDNA Verify launched at **$0.01 per active user per month** (2021) | Biometric Update, 2021 |
| Password-management market estimated at **$3.22B (2025)**, North America ~33% | Fortune Business Insights (via aboutchromebooks) **(secondary)** |

**Talking point:** "Behavioral biometrics is an accepted, regulated category sold to banks and DMVs. Nobody has shipped it open-source, self-hostable, and consumer-first with a real vault. That's the gap."

## Ready-to-use lines

- "Your password only works when *you* type it."
- "120 passwords. One rhythm."
- "The dark-web email doesn't have to be scary anymore."
- "No phone. No code. No dongle. Just type."
- "We can't read your vault. That's the whole point."
- "You'll always see the light." (consent)
- "Passkeys for the 48%. CypherKey for the rest."
- "Built in 2010 to tell humans from bots. Rebuilt in 2026 to tell you from everyone else."

## Devices and services (non-human logins)

You asked about devices and services that log in with passwords. Keystroke rhythm does not apply to machine-to-machine auth — say so; it keeps you honest. The relevant CypherKey stories are: the **CLI** for humans logging into servers (the SSH timing nod), and the **vault** storing device/router/NAS credentials that never get rotated. For service accounts, the answer is "use secrets managers" and don't overreach.
