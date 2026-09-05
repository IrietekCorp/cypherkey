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
    expect(manifest.permissions).toEqual(['storage']);
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
    expect(generated.permissions).toEqual(['storage']);
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
 * M2-10 gave the extension broad host access through its content script. That is the
 * single largest change to what the extension can reach, so it is pinned: a future
 * widening (adding `tabs`, `scripting`, `webRequest`, or host_permissions) has to
 * change this test deliberately rather than slip through.
 */
describe('what M2-10 granted, and what it did not', () => {
  const built = `${import.meta.dir}/.output/chrome-mv3/manifest.json`;

  test.skipIf(!existsSync(built))('one content script, and no new permissions', async () => {
    const generated = JSON.parse(await Bun.file(built).text()) as {
      permissions?: string[];
      host_permissions?: string[];
      content_scripts?: Array<{ matches?: string[] }>;
    };

    expect(generated.permissions).toEqual(['storage']);
    expect(generated).not.toHaveProperty('host_permissions');
    expect(generated.content_scripts).toHaveLength(1);
    expect(generated.content_scripts?.[0]?.matches).toEqual(['<all_urls>']);
  });
});
