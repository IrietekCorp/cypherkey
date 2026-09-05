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
