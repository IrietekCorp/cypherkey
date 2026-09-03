# 09 — Demo Script and Pitch (September 14)

## What you need in the room

- Laptop with a physical keyboard, cypherkey.io loaded, a hotspot as backup
- The 45-second backup video of the demo
- The one-pager (PDF) — email it after, don't hand it over first
- One enrolled passphrase you've practiced (use a 4-word phrase you type naturally; practice 20 times the day before, not 200)

## The 7-minute demo

**0:00 — Hook (30s)**
"In 2010 I was at CBS Sports. I built a captcha that told humans from bots by how they typed. Then I pointed it at passwords. I'd tell my teammates my password, and they still couldn't log in. Then I'd sit down — and I was in. That trick is now a product."

**0:30 — The problem in one breath (30s)**
"The average person has 120 passwords. Most are reused. Credential abuse shows up in about 39% of breaches. Everyone's answer is more steps: codes, apps, dongles, passkeys on six devices. Nobody's answer is *fewer* steps."

**1:00 — The trick (3 min)**
Open cypherkey.io. "This runs entirely in the browser — nothing leaves the laptop."
- Type a passphrase 8 times. Point at the Rhythm Light pulsing. "That dot is the only time we're listening, and you'll always see it."
- Hand him the laptop: "Here's my passphrase. Type it." Score shows — red or amber.
- Take it back, type it: green. "Same passphrase. Different rhythm."
- If it misfires: "That's the grey band — it asks you to type again or confirm another way. We designed for the bad day; nobody gets locked out by their own hands." Then try again.

**4:00 — What it actually is (1 min)**
"It's a zero-knowledge password manager — we can't read your vault, ever — with your typing rhythm as a built-in second factor. Open source. Self-host with one command. Hosted tier for people who don't want to run servers."

**5:00 — Why now, and what's different (1 min)**
"Behavioral biometrics is sold to banks and DMVs today by companies you've never heard of — closed, enterprise, per-verification pricing. Nobody has shipped it open-source and consumer-first with a real vault. And we're honest about it: it's a frictionless second signal, not magic. It complements passkeys — we store those too."

**6:00 — The ask (1 min)**
"I'm building solo with AI, public launch in January. I want intros to people who've built or funded security tools, and any founder who's launched on Hacker News. And I want your honest reaction to the demo — was there a moment you'd screenshot?"

## Questions he'll ask and answers

- **"Can't someone just copy my typing?"** "If they watch you type in person and are very good, maybe — that's why a new device always needs a second confirmation and why we tell users exactly that. It defeats the real attack: a password leaked from a breach, used from somewhere else."
- **"What if I break my hand?"** "You confirm with your passkey or a recovery code, and we retrain on the next few logins. You can also pause it. You never lose your vault."
- **"Biometric data — legal?"** "It's biometric data, so we treat it like the strictest law would: explicit consent, a visible indicator whenever we listen, only statistical aggregates stored, deleted with your account."
- **"How is this different from Bitwarden?"** "Same zero-knowledge posture and price band. They don't have a second factor you don't have to carry."
- **"Why would people pay?"** "Multiple devices, breach monitoring, emergency access — same levers as every password manager. And a B2B SDK later: any site can add this to its login form and their users are already enrolled when they flip it on."
- **"Why you?"** "I built it 16 years ago before the market existed. Now the market exists and the tooling makes a solo build possible."

## One-pager text

**CypherKey** — the open-source password manager where your password only works when you type it.

**Problem.** People juggle ~120 passwords, most reused. Credential abuse appears in ~39% of breaches. Every fix adds friction: codes, apps, dongles, passkeys that don't sync across ecosystems.

**Product.** A zero-knowledge vault (we cannot read it) plus a behavioral second factor built from the rhythm of typing your passphrase. No phone, no code, no device. Works with the passwords you already have. Open source (AGPL server, MIT client), self-host in one command, hosted tier for everyone else.

**Why it's different.** Only product that is simultaneously zero-extra-steps, replay-resistant, open source, and a real vault. Consent is a feature: the Rhythm Light shows whenever we listen. Fallbacks make sure your own hands can never lock you out.

**Why now.** Behavioral biometrics is an accepted category (banks, DMVs) sold closed and enterprise-only. Passkeys cover ~half of top sites; passwords guard the rest for decades.

**Business.** Free (2 devices) / Pro $30 yr / Family / Teams / SDK for services. Progressive Enrollment lets any site pre-enroll users and flip the switch.

**Traction targets.** Private beta Dec 2026. Public launch Jan 2027: 5K stars, 1K users; 100 paid by Q1.

**Founder.** Built the first version at CBSSports.com in 2010 as "KeyStroke Captcha." Solo, AI-assisted build.

**Ask.** Intros to security-tool founders/investors; HN-launch veterans; feedback on the demo.

cypherkey.io · github.com/[org]/cypherkey

## Checklist for the 14th

- [ ] Demo works on Safari and Chrome; test on the hotspot
- [ ] Backup video on the phone
- [ ] Repo README first screen is clean; stars button visible
- [ ] Email capture works (test it)
- [ ] Practice the demo with two people who aren't you — one should fail, you should pass
- [ ] Sleep; your rhythm is worse when tired (this is also a good joke for the room)
