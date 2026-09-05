/**
 * The manifest, as data, so the requirements that matter can be asserted in a test
 * rather than discovered when the popup fails to instantiate WASM in a real browser.
 */
export const CSP_EXTENSION_PAGES = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";

export const manifest: {
  name: string;
  description: string;
  permissions: string[];
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
  content_security_policy: {
    // Requirement 1 of M2-01: without 'wasm-unsafe-eval' the Argon2 module will not
    // instantiate under MV3, and the failure surfaces only in a real browser.
    extension_pages: CSP_EXTENSION_PAGES,
  },
};
