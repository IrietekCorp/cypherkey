import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { CSP_EXTENSION_PAGES, manifest } from './manifest';

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
    expect(manifest).not.toHaveProperty('host_permissions');
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
    };

    expect(generated.manifest_version).toBe(3);
    expect(generated.content_security_policy?.extension_pages).toContain("'wasm-unsafe-eval'");
    expect(generated.permissions).toEqual(['storage', 'activeTab', 'scripting']);
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
    expect(generated).not.toHaveProperty('host_permissions');
    expect(generated.permissions).toEqual(['storage', 'activeTab', 'scripting']);
  });

  test.skipIf(!existsSync(built))('the filler is built but not registered', async () => {
    // It exists to be injected on demand; being in the package is not being active.
    expect(existsSync(`${import.meta.dir}/.output/chrome-mv3/fill.js`)).toBe(true);
    const generated = JSON.parse(await Bun.file(built).text()) as { content_scripts?: unknown[] };
    expect(generated.content_scripts ?? []).toHaveLength(0);
  });
});
