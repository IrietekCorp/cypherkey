/**
 * The one inline script on the site, and the header that has to admit it.
 *
 * Every page stamps the palette in `<head>`, before first paint, so a visitor who chose
 * light never watches the page load dark and swap. That is an inline script, and the
 * site's CSP is `script-src 'self'` with no `unsafe-inline` — so the header carries a
 * `sha256-` for exactly this body.
 *
 * The header is not in this repository. It is `customResponseHeaders` on the site's
 * backend bucket, configured outside this repository, which means an edit to the script
 * here is silent: the page still builds, still deploys, and the browser refuses to run
 * the script in production. The failure looks like nothing at all except a console error
 * and a flash of the wrong palette.
 *
 * So the hash is pinned. Change the script and this fails, telling you to update the
 * header first.
 *
 * Four pages carry it now rather than one, which is the reason for the "identical"
 * test below: four *slightly* different stamps would need four hashes in the header, and
 * the one that was forgotten would be the one nobody visits during testing.
 */
import { describe, expect, test } from 'bun:test';

/** Must match the `sha256-` in the backend bucket's Content-Security-Policy. */
const PINNED = 'sha256-ychm5l4PEdBVuXXy83Van+P7FYJk9ejW6Dlypqs9s5A=';

const PAGES = ['index.html', 'demo.html', 'pricing.html', 'beta.html'] as const;

async function inlineScripts(page: string): Promise<string[]> {
  const html = await Bun.file(`${import.meta.dir}/${page}`).text();
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);
}

const hash = (body: string) =>
  `sha256-${new Bun.CryptoHasher('sha256').update(body).digest('base64')}`;

describe('the pre-paint theme stamp', () => {
  for (const page of PAGES) {
    test(`${page} carries exactly one inline script`, async () => {
      // Every one of these needs its own hash in a header nobody edits by accident.
      expect(await inlineScripts(page)).toHaveLength(1);
    });
  }

  test('every page carries the identical stamp, so one hash covers them all', async () => {
    const bodies = await Promise.all(PAGES.map(async (p) => (await inlineScripts(p))[0]));
    expect(new Set(bodies).size).toBe(1);
  });

  test('hashes to the value pinned in the deployed CSP', async () => {
    const body = (await inlineScripts('index.html'))[0] as string;
    expect(hash(body)).toBe(PINNED);
  });

  test('reads the choice, defaults to dark, and cannot leave the document unstamped', async () => {
    const body = (await inlineScripts('index.html'))[0] as string;
    expect(body).toContain('ck-theme');
    // Dark is the default; only an explicit 'light' moves off it.
    expect(body).toContain('"light" : "dark"');
    // A throw here would leave the document unstamped; dark is what it falls back to.
    expect(body).toContain('catch');
  });
});

describe('what the pages ask the browser to fetch', () => {
  /**
   * `default-src 'self'` covers fonts and media, so anything third-party here is a
   * request the deployed CSP will refuse. The site used to `@import` Inter from Google
   * and never got it: the import was dropped at build time, and the header would have
   * blocked it anyway. Self-hosting is the fix, and this is what keeps it that way.
   */
  test('no page reaches for a third-party origin', async () => {
    for (const page of [...PAGES, 'one-pager.html']) {
      const html = await Bun.file(`${import.meta.dir}/${page}`).text();
      // Only tags that *fetch*. An `<a href>` is somewhere a person may choose to go,
      // which the CSP has no opinion about; a `<script src>` is a request the page makes.
      const remote = [
        ...html.matchAll(/<(?:script|link|img|source)\b[^>]*\b(?:src|href)="(https?:\/\/[^"]+)"/g),
      ].map((m) => m[1] as string);
      expect(remote).toEqual([]);
    }
  });

  test('the stylesheet loads its own fonts', async () => {
    const css = await Bun.file(`${import.meta.dir}/styles.css`).text();
    expect(css).toContain('/fonts/archivo-latin.woff2');
    expect(css).toContain('/fonts/jetbrains-mono-latin.woff2');
    expect(css).not.toContain('fonts.googleapis.com');
  });
});
