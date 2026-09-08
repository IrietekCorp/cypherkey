# Where this is, and what to pick up next

**Written 2026-09-08.** A snapshot for resuming, not a spec — the specs are `docs/`, the
console record is `gcp.md`, and per-ticket truth is `docs/05-work-tickets.md`.

## The one-line version

M2 is complete and deployed. What is left is a small number of **founder decisions** and
the beta itself.

## What is live

| | Where | State |
|---|---|---|
| API | `https://api.cypherkey.io` | Cloud Run + Cloud SQL behind an HTTPS LB with Cloud Armor. `/healthz` → `{"ok":true,"db":"postgres"}` |
| Site | `https://cypherkey.io` | Cloud Storage + Cloud CDN. Light by default, Light/Dark/Auto in the nav |
| Extension | not published | Loads unpacked from `extension/.output/chrome-mv3`; onboarding, enrolment, unlock, the vault and the settings page all work end to end in real Chrome |

GCP project is **`<GCP_PROJECT_ID>`** (project number `<GCP_PROJECT_NUMBER>`, `us-central1`).
`gcloud` is **not installed system-wide** on this machine — the SDK tarball lives in the
session scratchpad and is extracted when needed.

## What was done most recently

**M2-14 is finished — the options page reaches a session, and two live bugs came out from
under it.**

- **The options page resumes.** `OptionsApp` reads the M2-18 snapshot out of
  `chrome.storage.session`, the same one the popup writes, and watches that key: unlocking
  in the popup opens the page without a reload, and locking in the popup closes it. It
  runs its own idle lock, which zeroes this document's keys and deliberately leaves the
  shared snapshot alone. **It offers no passphrase box** — a prompt on a tab nobody
  unlocked is the shape a phishing page takes, and the closed screen says so.
- **`authHash` was the typed passphrase.** Every step-up-gated control on the settings
  screen would have been refused by the server, with a message reading "That passphrase
  did not match." On the wire `authHash` is a derived value and the server stores a hash
  of *that*. `session.authProof()` derives it now, and the passphrase field became a
  capture field, because under Strict the key sequence is part of the key.
- **Nothing in the client ever refreshed an access token.** Tokens last fifteen minutes
  and sessions last an hour, so every session outlived its token: sync went quiet a
  quarter of an hour in and the vault fell back to "Offline" on a device that was online.
  `extension/src/authed.ts` refreshes once on a 401, writes the rotated pair back into the
  shared snapshot (A-9 rotates, and two documents read one snapshot), and retries.

**`browser-e2e` now goes the whole way**, 21 steps to 33. It finishes the eight enrolment
samples, builds the profile, unlocks against it, and opens the vault — then leaves the
options page open across the unlock and watches it come alive on its own, lists the
devices the server actually holds, refuses a weakening change with nothing typed, and has
the same change accepted with the passphrase typed. That last step is the A-17 round trip,
which had never run outside a test double.

Before that, and already on `main`: `8a296ab` light by default with a Light/Dark/System
control, `76f728d` the site CSP hash for the pre-paint theme stamp, and `1d25a28` the ten
screens the restyle had not reached.

## Next up, in the order I would do it

1. **Flip the repository public.** It clears M2-17's last thread and un-comments the
   GitHub links on the site (`site/index.html`, two blocks marked
   `HIDDEN UNTIL PUBLIC RELEASE`). Then tighten the workload-identity condition to
   `refs/heads/main`, which is deliberately loose while the repo is private.
2. **Decide on `RESEND_API_KEY`.** M2-15's "not your rhythm" email is built and tested and
   sends nothing without it. A self-hosted instance with no provider is a supported state,
   so this is a choice, not a gap.
3. **Run the beta.** The exit criterion is 25 users for 14 days, zero data-loss reports,
   median unlock under 4 s, grey-band rate under 10%.

## Known issues

- `extension/entrypoints/popup/Vault.test.tsx` — the M2-10 autofill test is
  **order-dependent**: it passes in a full run and fails when run alone. Pre-existing.
- **Crossing into or out of Strict is not reachable from any screen.** It is a re-key
  rather than a settings change; `session.changeStrictness()` exists, is tested, and has
  no caller. The settings screen hands off and says so rather than pretending.
- The **grey band** is a real outcome of `browser-e2e`, not a failure: the run types the
  same passphrase at a fixed 45 ms and still retypes when X-3 asks. It is capped at two
  retries, because a third would be a test typing until it gets in.
- Editing the inline `<script>` in `site/index.html` requires updating the CSP on the
  `cypherkey-site-backend` backend bucket **first**. `site/csp.test.ts` will fail if you
  forget; `deploy/README.md` has the command.

## How to verify everything at once

```bash
bun test                     # 1180 pass, 6 skip
bun run typecheck
bun run lint
bun run build:extension
bun run size-check           # popup eager 120 KB / 150 KB
bun run design-preview       # writes design-preview.png — both palettes, thirteen screens

# the browser e2e needs a build pointed at its own server, not production
VITE_CYPHERKEY_API=http://127.0.0.1:8791 bun run build:extension
bun run browser-e2e          # 33 steps in real Chrome
bun run build:extension      # put the production build back
```

**Why that last dance matters.** The unit tests substitute exactly the things that break —
an injected `fetch`, an in-process app, a controlled clock, SQLite for a pooled driver, a
config that is always supplied. Five production bugs passed 1,000+ of them. `browser-e2e`
and `design-preview` exist because of that, and both have since caught defects the tests
could not see.

The M2-14 pass added a sixth shape to the list, and it is the one to keep in mind: a
screen that had never been reached. Its tests passed while asserting the wrong value on
the wire, and the token that every one of them issued was spent in the same millisecond it
was minted. **A test suite cannot notice time passing, and it cannot notice a screen
nobody has opened.**

## Publishing the site

```bash
bun run build:site
gcloud storage cp site/dist/assets/* gs://<GCP_SITE_BUCKET>/assets/ \
  --project=<GCP_PROJECT_ID> --cache-control="public, max-age=31536000, immutable"
gcloud storage cp site/dist/index.html site/dist/one-pager.html gs://<GCP_SITE_BUCKET>/ \
  --project=<GCP_PROJECT_ID> --cache-control="public, max-age=300, must-revalidate"
gcloud storage rm gs://<GCP_SITE_BUCKET>/assets/<the previous hashed assets>
gcloud compute url-maps invalidate-cdn-cache cypherkey-lb --path="/*" --project=<GCP_PROJECT_ID>
```

The CDN clamps `max-age` to the backend's 3600 s client TTL; the headers above are still
worth setting so the object is right if it is ever served without the LB in front.
