import { describe, expect, test } from 'bun:test';

/**
 * The font strategy, pinned.
 *
 * The site sets type in Archivo and JetBrains Mono. The extension cannot afford either
 * in full, and the numbers are the argument rather than a preference: the eager popup
 * budget counts a stylesheet's fonts on purpose, because a bundled face is read before
 * the popup paints. Measured against a 150 KB budget on a 120 KB base — both faces
 * bundled, 182 KB (121%); Archivo alone, 151.5 KB (101%); Archivo subset to the wordmark,
 * 119.7 KB.
 *
 * So the arrangement Inter had is kept and the face is swapped: the wordmark is real
 * Archivo, subset to the letters of "CypherKey", and the UI runs on the platform's own
 * interface face. The vault renders arbitrary text a person saved, so the UI face is the
 * one thing here that must never be subset.
 *
 * These assert the arrangement rather than describe it, because every failure mode here
 * is quiet: a remote `@font-face` renders correctly in the tab used to test it and
 * silently fails under MV3, and a missing file falls back to a system face that looks
 * almost right.
 */
const tokens = await Bun.file(`${import.meta.dir}/tokens.css`).text();

const faces = [...tokens.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)].map((m) => m[1] as string);

describe('the wordmark face', () => {
  test('there is exactly one bundled face, and it is local', () => {
    expect(faces).toHaveLength(1);
    const face = faces[0] as string;
    // MV3 admits no remote font. This fails in the product and nowhere else.
    expect(face).not.toContain('fonts.googleapis.com');
    expect(face).not.toContain('fonts.gstatic.com');
    expect(face).not.toContain('http');
    expect(face).toContain('/fonts/archivo-wordmark.woff2');
  });

  test('is subset to the letters of "CypherKey" and nothing else', () => {
    // C K e h p r y. A face that carried more would cost more, and nothing else uses it.
    for (const point of ['U+43', 'U+4b', 'U+65', 'U+68', 'U+70', 'U+72', 'U+79']) {
      expect(tokens).toContain(point);
    }
  });

  test('the file is small enough to be a wordmark rather than a UI face', async () => {
    const file = Bun.file(`${import.meta.dir}/../../public/fonts/archivo-wordmark.woff2`);
    expect(await file.exists()).toBe(true);
    // A latin Archivo is 29-35 KB. Anything approaching that here means the subset was
    // lost in a re-export, and the eager budget goes with it.
    expect(file.size).toBeLessThan(8_000);
  });

  /** Retired with Nocturne. A stale face left in the package is bytes nobody notices. */
  test('the Inter wordmark subset is gone', async () => {
    expect(tokens).not.toContain('inter-wordmark');
    expect(
      await Bun.file(`${import.meta.dir}/../../public/fonts/inter-wordmark.woff2`).exists(),
    ).toBe(false);
  });
});

describe('the tokens that screens actually use', () => {
  const token = (name: string) => tokens.split(`${name}:`)[1]?.split(';')[0] ?? '';

  test('the UI face is the platform stack, and never the wordmark face', () => {
    expect(token('--ck-font')).toContain('system-ui');
    // The whole point: a nine-glyph face must never be asked to render a screen.
    expect(token('--ck-font')).not.toContain('Archivo');
  });

  test('the wordmark asks for Archivo first, then falls back to the UI stack', () => {
    expect(token('--ck-font-wordmark')).toContain('Archivo');
    expect(token('--ck-font-wordmark')).toContain('var(--ck-font)');
  });

  /** Mono is not decoration: it is how a measured number is told apart from a sentence. */
  test('there is a mono token for measured values', () => {
    expect(token('--ck-font-mono')).toContain('monospace');
    // Bundling JetBrains Mono costs 31 KB of a 150 KB budget for glyphs every platform
    // already ships a good version of.
    expect(token('--ck-font-mono')).not.toContain('JetBrains');
  });
});

describe('which palette arrives first', () => {
  /**
   * Dark is the default, and the light set is the derived one. The failure this catches
   * is a merge that restores `:root` to the light values, which looks fine in isolation
   * and puts every new install on the wrong palette.
   */
  test(':root is the dark ground and light is the override', () => {
    const root = tokens.slice(
      tokens.indexOf(':root {'),
      tokens.indexOf('}', tokens.indexOf(':root {')),
    );
    expect(root).toContain('--ck-bg: #141f2b');
    expect(root).toContain('color-scheme: dark');
    expect(tokens).toContain('[data-theme="light"]');
    expect(tokens).not.toContain('[data-theme="dark"]');
  });
});
