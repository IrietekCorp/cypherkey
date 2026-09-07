/**
 * The manifest, as data, so the requirements that matter can be asserted in a test
 * rather than discovered when the popup fails to instantiate WASM in a real browser.
 */
export const CSP_EXTENSION_PAGES = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";

/**
 * The one origin the extension may reach, kept beside the manifest that grants it so a
 * change to either is visible in the same diff. It must match
 * `PRODUCTION_API_BASE_URL` in `src/config.ts`; if they drift, every request fails in a
 * real browser while every test still passes.
 */
export const API_HOST_PERMISSION = 'https://api.cypherkey.io/*';

export const manifest: {
  name: string;
  description: string;
  permissions: string[];
  host_permissions: string[];
  content_security_policy: { extension_pages: string };
} = {
  name: 'CypherKey',
  description: 'A password manager that knows how you type.',
  /**
   * A-12: the least that works, and deliberately tighter than a password manager
   * usually asks for.
   *
   * **No `<all_urls>` content script.** Most managers declare one, because autofill
   * cannot know in advance which sites a vault covers. The trade taken here is the
   * other one: `activeTab` grants access to a single tab, only after the user invokes
   * the extension on it, and `scripting` injects the filler at that moment. The
   * extension therefore has no standing access to browsing at all.
   *
   * The cost is real and worth naming: nothing runs on pages the user has not pointed
   * the extension at, so **the punycode lookalike warning appears when a fill is
   * requested rather than when the page loads**. That is still before any credential is
   * released, but it cannot help someone who types a password by hand on a lookalike.
   */
  permissions: ['storage', 'activeTab', 'scripting'],
  /**
   * A-12, continued. This is **not** the widening the permission tests exist to
   * prevent. `<all_urls>` would grant standing access to every page the user visits;
   * this grants exactly one origin — our own API — which the extension cannot function
   * without, because an MV3 page has no other way to reach it. A cross-origin `fetch`
   * without this is refused by CORS, and the alternative (server-side CORS keyed to a
   * pinned extension id) buys nothing and moves the allowlist off the client where it
   * is harder to audit.
   *
   * The rule to hold: this list may contain the API and nothing else. A browsing origin
   * here is the failure the tests are watching for.
   */
  host_permissions: [API_HOST_PERMISSION],
  content_security_policy: {
    // Requirement 1 of M2-01: without 'wasm-unsafe-eval' the Argon2 module will not
    // instantiate under MV3, and the failure surfaces only in a real browser.
    extension_pages: CSP_EXTENSION_PAGES,
  },
};
