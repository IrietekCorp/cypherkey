# CypherKey — Development Package v1.0

**Prepared:** September 3, 2026
**For:** Solo founder building with a coding model (Claude Sonnet / Gemini)
**Hard date:** Demo on September 14, 2026

## What's in this package

| File | What it is | Who reads it |
|---|---|---|
| `01-vision-and-positioning.md` | Product thesis, personas, honest claims, competitive positioning, pricing | You, investors, README |
| `02-architecture-and-threat-model.md` | Zero-knowledge crypto design, biometric pipeline, sync, offline, threat model | You + the building model |
| `03-experience-design.md` | The Rhythm Light, enrollment, fallback/recovery ladder, Pause mode, delight features | You + the building model |
| `04-roadmap-and-milestones.md` | M0 (Sept 14) through M6 with dates and exit criteria | You |
| `05-work-tickets.md` | Model-sized tickets with acceptance criteria and copy-paste prompts | The building model |
| `06-AGENTS.md` | Drop into the repo root. Conventions, guardrails, definition of done | The building model (every session) |
| `07-infra-scaling-and-distribution.md` | GCP setup, cost curve, scaling triggers, launch and distribution plan | You |
| `08-marketing-data-sheet.md` | Verified statistics with sources, plus ready-to-use copy lines | You, marketing |
| `09-demo-script-sept14.md` | The 7-minute demo, pitch narrative, one-pager text | You |

## The five decisions this package locks in

1. **Name: CypherKey** (matches the domain). All code, env vars, and copy use `cypherkey` / `CYPHERKEY_*`. The legacy legacy spelling (with an i) variants are removed in ticket M1-01.
2. **Zero-knowledge vault.** The server can never decrypt a vault. No email password reset. Recovery via a user-held Recovery Kit.
3. **The Rhythm Light.** No keystroke timing is ever captured without a visible indicator. Consent is explicit, disclosed, and a selling point. "Silent pre-collection" is renamed **Progressive Enrollment** everywhere.
4. **Honest claim.** Typing rhythm is a *frictionless second signal* that makes stolen passwords useless on their own. It complements passkeys; it does not replace phishing-resistant auth. We never say "unhackable."
5. **Desktop first.** Browser extension + hosted server for launch; CLI next; mobile read-only after.

## How to use this package with a coding model

1. Copy `06-AGENTS.md` to your repo root as `AGENTS.md` (also symlink or copy to `CLAUDE.md` / `GEMINI.md` depending on tool).
2. Copy `02-architecture-and-threat-model.md` and `03-experience-design.md` into `docs/` in the repo. Tickets reference them by section number.
3. Work one ticket at a time from `05-work-tickets.md`. Paste the ticket's **Prompt** block verbatim as your first message in a fresh session. Do not batch tickets. Do not let the model "also improve" adjacent code.
4. After each ticket, run the Definition of Done checklist yourself. If tests don't pass, paste the failing output back with "Fix only this failure."
5. Commit per ticket. Branch per milestone.

## Reading order if you only have 30 minutes

`09-demo-script-sept14.md` → `04-roadmap-and-milestones.md` → M0 tickets in `05-work-tickets.md`. Everything else can wait until after the 14th.
