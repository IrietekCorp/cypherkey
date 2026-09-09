# Where this is, and what to pick up next

**Written 2026-09-08.** A snapshot for resuming, not a spec — the specs are `docs/`, the
console record is the local `gcp.md` operations log — untracked, because it is only
about whose infrastructure this is — and per-ticket truth is `docs/05-work-tickets.md`.

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

**The redesign landed** — "eco, human, precise", replacing Nocturne. Dark is the default
again (reversing the light-default call), type is Archivo and JetBrains Mono, green is the
living signal and blue is measurement.

- **The site is four pages**: landing with the hero video loop, the Rhythm Trial, pricing,
  beta. Tailwind is gone; five pages cost 32 KB gzipped where two cost 30 KB.
- **The Trial runs on the real `core/biometrics`** rather than a demo re-implementation,
  and `bun run trial-e2e` plays it in a browser to prove the claim: eight consistent
  samples, then a deliberately erratic stranger, and the stranger is refused while the
  owner passes — at Strict too.
- **The extension restyled from `tokens.css` alone**, because every component consumes the
  tokens by name. The Rhythm Light is 28px now.
- **Fonts are self-hosted on the site** — which also fixes a live bug: the site asked
  Google for Inter, never got it (the `@import` was dropped at build and the CSP would
  have refused it), and every visitor has been reading the system face.

### Not done, and deliberately

- **The extension's Unlock and Vault markup** still carries its previous copy and
  structure. The palette, type, defaults and the Rhythm Light are the redesign's; the
  four Unlock faces and the Vault's avatar and counts are not yet the handoff's exact
  screens.
- **`landing-origin`** is the one photograph the handoff did not include. That strip
  carries a timing-trace motif in the meantime.
- **The extension does not bundle Archivo or JetBrains Mono in full.** It cannot: both
  measured 182 KB against a 150 KB eager budget, Archivo alone 151.5 KB. The wordmark is
  real Archivo subset to nine characters; the UI keeps the platform face. Raising A-15 is
  a decision, and the numbers are in `extension/src/design/typography.test.ts`.
- **The site is built but not published.** The deployed CSP names the old inline theme
  stamp by hash and would refuse the new one — see below.


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

**`RESEND_API_KEY` was read by no line of code.** M2-15's mailer, its transport and its
one-per-hour throttle were written and tested behind an injected seam, `createApp` took an
optional `mailer` — and nothing ever built one. Creating the secret would have changed
nothing, silently, and the first evidence would have been a beta user who was never told
someone had typed their passphrase. Same shape as M2-16's `createApp({ db })`: a seam
every test supplies and the entrypoint does not. `Config` carries `mail` now, the
entrypoint builds the mailer from it, half-configured mail refuses to start, and
`server/src/index.test.ts` boots the real file — the first test in the tree that does.

**`browser-e2e` now goes the whole way**, 21 steps to 33. It finishes the eight enrolment
samples, builds the profile, unlocks against it, and opens the vault — then leaves the
options page open across the unlock and watches it come alive on its own, lists the
devices the server actually holds, refuses a weakening change with nothing typed, and has
the same change accepted with the passphrase typed. That last step is the A-17 round trip,
which had never run outside a test double.

Before that, and already on `main`: `5061d15` light by default with a Light/Dark/System
control, `9934739` the site CSP hash for the pre-paint theme stamp, and `d1740de` the ten
screens the restyle had not reached.

## Next up, in the order I would do it

1. **Flip the repository public.** It clears M2-17's last thread and un-comments the
   GitHub links on the site (`site/index.html`, two blocks marked
   `HIDDEN UNTIL PUBLIC RELEASE`). Then tighten the workload-identity condition to
   `refs/heads/main`, which is deliberately loose while the repo is private.
2. **Turn mail on, or leave it off.** M2-15's "not your rhythm" email is wired to the
   config now — it was not, and setting the secret alone would have done nothing (below).
   Off is a supported state and costs nothing. On is six steps, in `deploy/README.md`, and the
   long pole is **verifying a sending domain**: `cypherkey.io` publishes no TXT records,
   so Resend will not send from it until DKIM and SPF are in the `cypherkey-io` zone.
   `deploy/service.yaml` carries the block, commented.
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
bun test                     # 1199 pass, 6 skip
bun run typecheck
bun run lint
bun run build:extension
bun run size-check           # popup eager 120 KB / 150 KB
bun run design-preview       # writes design-preview.png — both palettes, thirteen screens

# the browser e2e needs a build pointed at its own server, not production
VITE_CYPHERKEY_API=http://127.0.0.1:8791 bun run build:extension
bun run browser-e2e          # 33 steps in real Chrome
bun run build:extension      # put the production build back

# the Rhythm Trial, against the built site
bun run build:site
bun run trial-e2e            # 12 steps; the intruder must be refused
```

**Chrome, for both browser tests.** Branded Google Chrome cannot run them: it has ignored
`--load-extension` in an automated session since 137, and 152 removed the switch that
opted back out. Install one that can — `bunx @puppeteer/browsers install chrome@stable` —
and point `CHROME_PATH` at it. CI does this per run.

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

**Update the CSP first.** Every page now carries the pre-paint theme stamp, and its body
changed, so the deployed header's `sha256-` no longer matches. Publishing before the
header is updated leaves every page loading on the wrong palette and swapping.

Add the new hash *beside* the old one, publish, then drop the old one — a header carrying
only the new hash breaks the currently-live pages until the upload finishes.

```bash
# the value site/csp.test.ts pins
gcloud compute backend-buckets update cypherkey-site-backend --project=<GCP_PROJECT_ID> \
  --custom-response-header="Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'sha256-ychm5l4PEdBVuXXy83Van+P7FYJk9ejW6Dlypqs9s5A='; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" \
  # ...and every other header: --custom-response-header REPLACES the whole list
```

Fonts and media need no new directive: they are same-origin, so `default-src 'self'`
already admits them. That is a reason to keep them same-origin.

```bash
bun run build:site
gcloud storage cp -r site/dist/assets/* gs://<GCP_SITE_BUCKET>/assets/ \
  --project=<GCP_PROJECT_ID> --cache-control="public, max-age=31536000, immutable"
# fonts/ and media/ are content-addressed by name rather than by hash, so they take a
# shorter TTL than the hashed assets and a longer one than the HTML
gcloud storage cp -r site/dist/fonts site/dist/media gs://<GCP_SITE_BUCKET>/ \
  --project=<GCP_PROJECT_ID> --cache-control="public, max-age=86400"
gcloud storage cp site/dist/*.html gs://<GCP_SITE_BUCKET>/ \
  --project=<GCP_PROJECT_ID> --cache-control="public, max-age=300, must-revalidate"
gcloud storage rm gs://<GCP_SITE_BUCKET>/assets/<the previous hashed assets>
gcloud compute url-maps invalidate-cdn-cache cypherkey-lb --path="/*" --project=<GCP_PROJECT_ID>
```

The CDN clamps `max-age` to the backend's 3600 s client TTL; the headers above are still
worth setting so the object is right if it is ever served without the LB in front.
