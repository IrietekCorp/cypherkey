/**
 * The one inline script on the site, and the header that has to admit it.
 *
 * `index.html` stamps the palette in `<head>`, before first paint, so a visitor who
 * chose dark never watches the page load light and swap. That is an inline script, and
 * the site's CSP is `script-src 'self'` with no `unsafe-inline` — so the header carries
 * a `sha256-` for exactly this body.
 *
 * The header is not in this repository. It is `customResponseHeaders` on the
 * `cypherkey-site-backend` backend bucket (see gcp.md §9.3), which means an edit to the
 * script here is silent: the page still builds, still deploys, and the browser refuses
 * to run the script in production. The failure looks like nothing at all except a
 * console error and a flash of the wrong palette.
 *
 * So the hash is pinned. Change the script and this fails, telling you to update the
 * header first.
 */
import { describe, expect, test } from 'bun:test';

/** Must match the `sha256-` in the backend bucket's Content-Security-Policy. */
const PINNED = 'sha256-mmJN3GwOEPpR6oAUsPnSozXTcUFPKLc4vUiwODCiL/A=';

const html = await Bun.file(`${import.meta.dir}/index.html`).text();

function inlineScripts(): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);
}

describe('the pre-paint theme stamp', () => {
  test('is the only inline script on the page', () => {
    // Every one of these needs its own hash in a header nobody edits by accident.
    expect(inlineScripts()).toHaveLength(1);
  });

  test('hashes to the value pinned in the deployed CSP', () => {
    const body = inlineScripts()[0] as string;
    const digest = new Bun.CryptoHasher('sha256').update(body).digest('base64');
    expect(`sha256-${digest}`).toBe(PINNED);
  });

  test('resolves all three choices, and defaults to light', () => {
    const body = inlineScripts()[0] as string;
    expect(body).toContain('cypherkey.theme');
    expect(body).toContain('prefers-color-scheme: dark');
    // A throw here would leave the document unstamped; light is what it falls back to.
    expect(body).toContain('catch');
  });
});
