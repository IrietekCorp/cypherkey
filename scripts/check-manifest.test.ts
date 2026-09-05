import { describe, expect, test } from 'bun:test';
import { validateManifest } from './check-manifest';

const VALID = {
  manifest_version: 3,
  version: '0.1.0',
  permissions: ['storage'],
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
};

describe('validateManifest', () => {
  test('the manifest we ship passes', () => {
    expect(validateManifest(VALID)).toEqual([]);
  });

  /**
   * The one that cost a manual load failure: WXT emitted `matches: []` from a
   * placeholder content script, and Chrome refused the entire extension.
   */
  test('an empty content script matches is caught', () => {
    const problems = validateManifest({ ...VALID, content_scripts: [{ matches: [] }] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('content_scripts[0].matches is empty');
  });

  test('a content script with matches is fine', () => {
    expect(validateManifest({ ...VALID, content_scripts: [{ matches: ['https://*/*'] }] })).toEqual(
      [],
    );
  });

  test("a CSP without 'wasm-unsafe-eval' is caught", () => {
    const problems = validateManifest({
      ...VALID,
      content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
    });
    expect(problems[0]).toContain('wasm-unsafe-eval');
  });

  test("'unsafe-inline' is caught even alongside the WASM allowance", () => {
    const problems = validateManifest({
      ...VALID,
      content_security_policy: {
        extension_pages: "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
      },
    });
    expect(problems.some((p) => p.includes('unsafe-inline'))).toBe(true);
  });

  test('a missing version and a wrong manifest_version are caught', () => {
    expect(validateManifest({ ...VALID, version: undefined })).toContain('version is required');
    expect(validateManifest({ ...VALID, manifest_version: 2 })).toContain(
      'manifest_version must be 3',
    );
  });

  test('a web-accessible resource with no matches is caught', () => {
    const problems = validateManifest({ ...VALID, web_accessible_resources: [{ matches: [] }] });
    expect(problems[0]).toContain('web_accessible_resources[0]');
  });
});
