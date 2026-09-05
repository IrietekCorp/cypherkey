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
  // A-12: the least that works. No host permissions until M2-10 needs them, and no
  // "tabs" — the content script is injected per-site with explicit user action.
  permissions: ['storage'],
  content_security_policy: {
    // Requirement 1 of M2-01: without 'wasm-unsafe-eval' the Argon2 module will not
    // instantiate under MV3, and the failure surfaces only in a real browser.
    extension_pages: CSP_EXTENSION_PAGES,
  },
};
