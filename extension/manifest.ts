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
   * A-12: the least that works.
   *
   * `storage` only. Still no `tabs`, no `scripting`, no `webRequest`.
   *
   * The content script matches `<all_urls>`, which is the real cost here and is a
   * decision worth stating rather than absorbing: autofill cannot know in advance which
   * sites a vault covers, so a password manager either has broad host access or it is
   * not an autofilling password manager. The alternative — `activeTab` with injection
   * on a toolbar click — is genuinely tighter, and turns autofill into "click the
   * extension first, then fill", which is a different product.
   *
   * What that access is used for is deliberately narrow: the script detects fields and
   * warns about a punycode host. It never fills on its own; a fill happens only when
   * the user asks for one through the popup.
   */
  permissions: ['storage'],
  content_security_policy: {
    // Requirement 1 of M2-01: without 'wasm-unsafe-eval' the Argon2 module will not
    // instantiate under MV3, and the failure surfaces only in a real browser.
    extension_pages: CSP_EXTENSION_PAGES,
  },
};
