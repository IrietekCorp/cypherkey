/**
 * The metadata search engines read, and the ways it silently goes wrong.
 *
 * None of this is visible on the page, which is exactly the problem: a canonical URL
 * pointing at the wrong file, a JSON-LD block with a trailing comma, or a sitemap still
 * listing a page that has since been marked `noindex` all fail in total silence and are
 * found weeks later in Search Console. So they are asserted here instead.
 */
import { describe, expect, test } from 'bun:test';

/** Every page that wants to be found, and the URL each one claims as canonical. */
const INDEXED: Record<string, string> = {
  'index.html': 'https://cypherkey.io/',
  'demo.html': 'https://cypherkey.io/demo.html',
  'technology.html': 'https://cypherkey.io/technology.html',
  'compare.html': 'https://cypherkey.io/compare.html',
  'pricing.html': 'https://cypherkey.io/pricing.html',
  'beta.html': 'https://cypherkey.io/beta.html',
  'founder.html': 'https://cypherkey.io/founder.html',
};

/** Deliberately not indexed: a link we hand to people, and the redirect that feeds it. */
const NOT_INDEXED = ['investors.html', 'one-pager.html'];

const read = (page: string) => Bun.file(`${import.meta.dir}/${page}`).text();

/** The first capture group, or '' when the tag is absent — which is itself a failure. */
const group = (text: string, pattern: RegExp): string => text.match(pattern)?.[1] ?? '';

const jsonLd = (html: string): string[] =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (m) => m[1] as string,
  );

describe('the metadata every indexed page carries', () => {
  for (const [page, url] of Object.entries(INDEXED)) {
    test(`${page} names itself canonical, and names itself correctly`, async () => {
      const html = await read(page);
      expect(html).toContain(`<link rel="canonical" href="${url}" />`);
      // A canonical that disagrees with og:url is a page telling two stories.
      expect(html).toContain(`<meta property="og:url" content="${url}" />`);
    });

    test(`${page} has a title and a description worth showing`, async () => {
      const html = await read(page);
      const title = group(html, /<title>([\s\S]*?)<\/title>/);
      const description = group(html, /<meta\s+name="description"\s+content="([\s\S]*?)"\s*\/>/);

      // Google truncates around 60 and 160; empty or absent is the real failure.
      expect(title.trim().length).toBeGreaterThan(10);
      expect(title.length).toBeLessThanOrEqual(75);
      expect(description.trim().length).toBeGreaterThan(50);
    });

    test(`${page} credits its author`, async () => {
      expect(await read(page)).toContain('<meta name="author" content="Shawn J. Stewart" />');
    });
  }

  test('no two indexed pages claim the same title', async () => {
    const titles = await Promise.all(
      Object.keys(INDEXED).map(async (page) =>
        group(await read(page), /<title>([\s\S]*?)<\/title>/).trim(),
      ),
    );
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe('the pages that must stay out of the index', () => {
  test('the investor overview says noindex and claims no canonical', async () => {
    const html = await read('investors.html');
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).not.toContain('rel="canonical"');
  });

  test('robots.txt disallows them and points at the sitemap', async () => {
    const robots = await Bun.file(`${import.meta.dir}/public/robots.txt`).text();
    for (const page of NOT_INDEXED) expect(robots).toContain(`Disallow: /${page}`);
    expect(robots).toContain('Sitemap: https://cypherkey.io/sitemap.xml');
  });
});

describe('the sitemap', () => {
  test('lists exactly the pages that want indexing, by their canonical URL', async () => {
    const xml = await Bun.file(`${import.meta.dir}/public/sitemap.xml`).text();
    const listed = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] as string);
    expect(new Set(listed)).toEqual(new Set(Object.values(INDEXED)));
    // A duplicated <loc> is a sitemap that has been edited twice and read once.
    expect(listed.length).toBe(new Set(listed).size);
  });

  test('lists nothing that is disallowed', async () => {
    const xml = await Bun.file(`${import.meta.dir}/public/sitemap.xml`).text();
    // The <loc> values, not the raw file: the comment above them is allowed to explain
    // which pages are deliberately absent by naming them.
    const listed = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] as string);
    for (const page of NOT_INDEXED) {
      expect(listed.some((loc) => loc.endsWith(page))).toBe(false);
    }
  });
});

describe('structured data', () => {
  /**
   * These blocks are hand-written JSON inside HTML, which is the single easiest thing on
   * the site to break: a trailing comma costs nothing at build time, throws no error in
   * the browser, and simply removes the page from every rich result it was eligible for.
   */
  test('every ld+json block on the site parses', async () => {
    for (const page of [...Object.keys(INDEXED), ...NOT_INDEXED]) {
      for (const block of jsonLd(await read(page))) {
        expect(() => JSON.parse(block) as unknown).not.toThrow();
      }
    }
  });

  test('the landing page and the founder page agree on who Shawn is', async () => {
    const ID = 'https://cypherkey.io/founder.html#shawn';

    const landing = jsonLd(await read('index.html')).map(
      (b) => JSON.parse(b) as Record<string, unknown>,
    );
    const graph = landing.flatMap((b) => (b['@graph'] ?? []) as Record<string, unknown>[]);
    const person = graph.find((node) => node['@type'] === 'Person');
    expect(person?.['@id']).toBe(ID);
    expect(person?.name).toBe('Shawn J. Stewart');

    // The founder page is where that `@id` is defined; every other page only references it.
    const profile = JSON.parse(jsonLd(await read('founder.html'))[0] as string) as {
      mainEntity: Record<string, unknown>;
    };
    expect(profile.mainEntity['@id']).toBe(ID);
    expect(profile.mainEntity.name).toBe('Shawn J. Stewart');
  });
});
