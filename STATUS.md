# Where this is, and what to pick up next

**Written 2026-09-08.** A snapshot for resuming, not a spec — the specs are `docs/`, the
console record is `gcp.md`, and per-ticket truth is `docs/05-work-tickets.md`.

## The one-line version

M2 is functionally complete and deployed. What is left is a small number of **founder
decisions**, one piece of **session plumbing** (the options page), and the beta itself.

## What is live

| | Where | State |
|---|---|---|
| API | `https://api.cypherkey.io` | Cloud Run + Cloud SQL behind an HTTPS LB with Cloud Armor. `/healthz` → `{"ok":true,"db":"postgres"}` |
| Site | `https://cypherkey.io` | Cloud Storage + Cloud CDN. Light by default, Light/Dark/Auto in the nav |
| Extension | not published | Loads unpacked from `extension/.output/chrome-mv3`; onboarding through unlock works end to end in real Chrome |

GCP project is **`<GCP_PROJECT_ID>`** (project number `<GCP_PROJECT_NUMBER>`, `us-central1`).
`gcloud` is **not installed system-wide** on this machine — the SDK tarball lives in the
session scratchpad and is extracted when needed.

## What was done most recently

Three commits, all pushed to `main`:

- `8a296ab` — **light is the default**, with a three-state Light/Dark/System control on the
  extension (Profile → Appearance, stored in `chrome.storage.local`) and on the site (nav).
  Dark is unchanged and one tap away.
- `76f728d` — the site's CSP refused the pre-paint theme stamp. The deployed header names
  that inline script by `sha256-`, and `site/csp.test.ts` pins the hash.
- `1d25a28` — the **ten screens the restyle had not reached**: onboarding, Recovery Kit and
  its confirmation, enrolment, item edit, generator, import, feedback, the options page,
  and `@media print` for the Kit sheet.

## Next up, in the order I would do it

1. **Flip the repository public.** It clears M2-17's last thread and un-comments the
   GitHub links on the site (`site/index.html`, two blocks marked
   `HIDDEN UNTIL PUBLIC RELEASE`). Then tighten the workload-identity condition to
   `refs/heads/main`, which is deliberately loose while the repo is private.
2. **Decide on `RESEND_API_KEY`.** M2-15's "not your rhythm" email is built and tested and
   sends nothing without it. A self-hosted instance with no provider is a supported state,
   so this is a choice, not a gap.
3. **Wire the options page** (the rest of M2-14). `Settings.tsx` is written, styled and
   tested; the page cannot reach a session. `extension/src/resume.ts` already keeps a
   snapshot in `chrome.storage.session` that both documents can read — that is the seam.
4. **Run the beta.** The exit criterion is 25 users for 14 days, zero data-loss reports,
   median unlock under 4 s, grey-band rate under 10%.

## Known issues

- `extension/entrypoints/popup/Vault.test.tsx` — the M2-10 autofill test is
  **order-dependent**: it passes in a full run and fails when run alone. Pre-existing.
- The **options page** renders a styled "not open yet" placeholder (see above).
- Editing the inline `<script>` in `site/index.html` requires updating the CSP on the
  `cypherkey-site-backend` backend bucket **first**. `site/csp.test.ts` will fail if you
  forget; `deploy/README.md` has the command.

## How to verify everything at once

```bash
bun test                     # 1146 pass, 6 skip
bun run typecheck
bun run lint
bun run build:extension
bun run size-check           # popup eager 119 KB / 150 KB
bun run design-preview       # writes design-preview.png — both palettes, twelve screens

# the browser e2e needs a build pointed at its own server, not production
VITE_CYPHERKEY_API=http://127.0.0.1:8791 bun run build:extension
bun run browser-e2e          # 21 steps in real Chrome
bun run build:extension      # put the production build back
```

**Why that last dance matters.** The unit tests substitute exactly the things that break —
an injected `fetch`, an in-process app, a controlled clock, SQLite for a pooled driver, a
config that is always supplied. Five production bugs passed 1,000+ of them. `browser-e2e`
and `design-preview` exist because of that, and both have since caught defects the tests
could not see.

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
