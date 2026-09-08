import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { API_HOST_PERMISSION, CSP_EXTENSION_PAGES, devHostPermission, manifest } from './manifest';

/**
 * What the built manifest may legitimately carry.
 *
 * A development build adds the dev API origin and the pinned key, both gated on
 * `VITE_CYPHERKEY_API`. Asserting the production list against whatever happens to be in
 * `.output` made these tests depend on which build ran last: a developer with a dev build
 * got two failures that looked like a security regression and were not.
 *
 * So the shape is asserted against the build that exists. What never bends: production
 * is exactly the API origin, a dev build adds exactly one more, and neither may name a
 * browsing origin.
 */
function expectedHostPermissions(generated: { key?: string; host_permissions?: string[] }): void {
  const permissions = generated.host_permissions ?? [];
  expect(permissions[0]).toBe(API_HOST_PERMISSION);
  if (generated.key === undefined) {
    expect(permissions).toEqual([API_HOST_PERMISSION]);
    return;
  }
  // A dev build: one extra origin, and it must be the local one the build talks to.
  expect(permissions).toHaveLength(2);
  expect(permissions[1]).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\*$/);
}

describe('manifest', () => {
  /**
   * Requirement 1 of M2-01. Without this the Argon2 module will not instantiate under
   * MV3, and nothing catches it until someone loads the extension in a real browser —
   * so it is asserted here where it costs nothing to notice.
   */
  test("extension_pages CSP allows 'wasm-unsafe-eval'", () => {
    expect(manifest.content_security_policy.extension_pages).toContain("'wasm-unsafe-eval'");
    expect(CSP_EXTENSION_PAGES).toContain("script-src 'self'");
  });

  test('the CSP does not open anything else', () => {
    // 'unsafe-eval' or 'unsafe-inline' would defeat the point of having a CSP at all.
    expect(manifest.content_security_policy.extension_pages).not.toContain("'unsafe-eval'");
    expect(manifest.content_security_policy.extension_pages).not.toContain("'unsafe-inline'");
    expect(manifest.content_security_policy.extension_pages).not.toContain('http:');
  });

  /** A-12: ask for the least that works. Each addition needs its own justification. */
  test('permissions are minimal', () => {
    // `activeTab` + `scripting` instead of an <all_urls> content script: access to one
    // tab, only after the user invokes the extension on it.
    expect(manifest.permissions).toEqual(['storage', 'activeTab', 'scripting']);
  });

  /**
   * `host_permissions` was empty until the extension had a server to talk to. It now
   * holds exactly one entry, and the point of this test is that it stays that way: an
   * MV3 page cannot reach its own API without it, but a browsing origin here would be
   * the standing access the posture exists to refuse.
   */
  test('host_permissions grants the API and nothing else', () => {
    expect(manifest.host_permissions).toEqual([API_HOST_PERMISSION]);
    expect(API_HOST_PERMISSION).toBe('https://api.cypherkey.io/*');
  });

  /**
   * A development build talking to a local server needs that origin permitted, and a
   * shipped build must never carry it. Both come from `VITE_CYPHERKEY_API`, so the
   * permission cannot name an origin the build does not use.
   */
  describe('the development origin', () => {
    test('is empty unless a dev API is configured', () => {
      expect(devHostPermission(undefined)).toEqual([]);
      expect(devHostPermission('')).toEqual([]);
      expect(devHostPermission('   ')).toEqual([]);
    });

    test('is added for a local server', () => {
      expect(devHostPermission('http://localhost:3000')).toEqual(['http://localhost:3000/*']);
      expect(devHostPermission('http://127.0.0.1:8787/')).toEqual(['http://127.0.0.1:8787/*']);
    });

    test('never duplicates production', () => {
      expect(devHostPermission('https://api.cypherkey.io')).toEqual([]);
    });

    test('a production build carries no dev key', () => {
      // The pinned id is a development convenience. A shipped build takes its identity
      // from the store, and a key here would silently override that.
      expect(manifest).not.toHaveProperty('key');
    });

    test('a value that is not a URL grants nothing', () => {
      // Failing closed: a typo must not become a permission.
      expect(devHostPermission('not a url')).toEqual([]);
    });
  });

  test('host_permissions contains no browsing origin', () => {
    for (const entry of manifest.host_permissions) {
      expect(entry.startsWith('https://')).toBe(true);
      expect(entry).not.toBe('<all_urls>');
      // `https://*/*` and friends are the shapes that quietly mean "everything".
      expect(entry).not.toMatch(/^https:\/\/\*/);
    }
  });
});

/**
 * The config object is not the manifest Chrome loads. WXT generates that, and a build
 * step could drop or rewrite the CSP without any of the assertions above noticing — so
 * check the real artefact when one has been built.
 */
describe('the generated manifest', () => {
  const built = `${import.meta.dir}/.output/chrome-mv3/manifest.json`;

  test.skipIf(!existsSync(built))("carries 'wasm-unsafe-eval' through the build", async () => {
    const generated = JSON.parse(await Bun.file(built).text()) as {
      manifest_version: number;
      content_security_policy?: { extension_pages?: string };
      permissions?: string[];
      host_permissions?: string[];
      key?: string;
    };

    expect(generated.manifest_version).toBe(3);
    expect(generated.content_security_policy?.extension_pages).toContain("'wasm-unsafe-eval'");
    expect(generated.permissions).toEqual(['storage', 'activeTab', 'scripting']);
    expectedHostPermissions(generated);
  });
});

/**
 * Chrome refuses to load a manifest whose `content_scripts` entry has an empty
 * `matches`, and the failure is total: the extension does not load at all. A no-op
 * placeholder content script cost a load failure once; this stops it recurring.
 */
describe('the generated manifest is loadable', () => {
  const built = `${import.meta.dir}/.output/chrome-mv3/manifest.json`;

  test.skipIf(!existsSync(built))('no content script declares an empty matches', async () => {
    const generated = JSON.parse(await Bun.file(built).text()) as {
      content_scripts?: Array<{ matches?: string[] }>;
    };

    for (const entry of generated.content_scripts ?? []) {
      expect(entry.matches ?? []).not.toHaveLength(0);
    }
  });
});

/**
 * The permission posture, pinned.
 *
 * M2-10 first shipped an `<all_urls>` content script, which is what a password manager
 * usually asks for. It was deliberately given up: the extension now holds `activeTab`,
 * so it reaches one tab only after the user invokes it there, and has no standing
 * access to browsing. Any widening has to change this test on purpose.
 */
describe('the extension has no standing access to browsing', () => {
  const built = `${import.meta.dir}/.output/chrome-mv3/manifest.json`;

  test.skipIf(!existsSync(built))('no content script is declared at all', async () => {
    const generated = JSON.parse(await Bun.file(built).text()) as {
      permissions?: string[];
      host_permissions?: string[];
      content_scripts?: unknown[];
    };

    // Nothing runs on a page the user has not pointed the extension at.
    expect(generated.content_scripts ?? []).toHaveLength(0);
    expect(generated.permissions).toEqual(['storage', 'activeTab', 'scripting']);
    // The API origin is allowed; a browsing origin is what this is guarding.
    expectedHostPermissions(generated);
  });

  test.skipIf(!existsSync(built))('the filler is built but not registered', async () => {
    // It exists to be injected on demand; being in the package is not being active.
    expect(existsSync(`${import.meta.dir}/.output/chrome-mv3/fill.js`)).toBe(true);
    const generated = JSON.parse(await Bun.file(built).text()) as { content_scripts?: unknown[] };
    expect(generated.content_scripts ?? []).toHaveLength(0);
  });
});
