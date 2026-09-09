import { describe, expect, test } from 'bun:test';

/**
 * The font strategy, pinned.
 *
 * The extension and the site set type identically: Archivo for what a person reads,
 * JetBrains Mono for what the machine measured.
 *
 * That cost a budget decision rather than a preference. The eager popup budget counts a
 * stylesheet's fonts on purpose, because a bundled face is read before the popup paints,
 * and both faces measured 182 KB against the old 150 KB ceiling. The three options were
 * subsetting the UI face, dropping one face, or raising A-15 — and the first is not
 * available, because the vault renders whatever text a person saved and a face that
 * cannot render it produces a string half in Archivo and half in something else.
 *
 * A-15 was raised to 230 KB on 2026-09-09. What it buys is one typographic system; what
 * it costs is bounded, because a bundled face is a local file read rather than a download
 * and `font-display: swap` means it never blocks a first paint.
 *
 * These assert the arrangement rather than describe it, because every failure mode here
 * is quiet: a remote `@font-face` renders correctly in the tab used to test it and
 * silently fails under MV3, and a missing file falls back to a system face that looks
 * almost right.
 */
const tokens = await Bun.file(`${import.meta.dir}/tokens.css`).text();

const faces = [...tokens.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)].map((m) => m[1] as string);

describe('the bundled faces', () => {
  test('there are exactly two, and both are local', () => {
    expect(faces).toHaveLength(2);
    for (const face of faces) {
      // MV3 admits no remote font. This fails in the product and nowhere else.
      expect(face).not.toContain('fonts.googleapis.com');
      expect(face).not.toContain('fonts.gstatic.com');
      expect(face).not.toContain('http');
      expect(face).toContain('/fonts/');
    }
  });

  test('they are the two the design system names', () => {
    expect(tokens).toContain('/fonts/archivo-latin.woff2');
    expect(tokens).toContain('/fonts/jetbrains-mono-latin.woff2');
  });

  /**
   * A variable font declares a weight *range*. Declaring a single weight against a
   * variable file makes the browser synthesise the others, and a synthesised 800 is what
   * a heading looks like when it is subtly wrong and nobody can say why.
   */
  test('each declares a weight range, because each is variable', () => {
    for (const face of faces) {
      expect(face).toMatch(/font-weight:\s*\d00\s+\d00/);
    }
  });

  /**
   * The size guard is the point of this file. 62 KB of the eager budget is these two, so
   * a re-export that lost the latin subset would eat the headroom the raise bought.
   */
  test('the files exist and are a latin subset, not a full unicode face', async () => {
    let total = 0;
    for (const name of ['archivo-latin.woff2', 'jetbrains-mono-latin.woff2']) {
      const file = Bun.file(`${import.meta.dir}/../../public/fonts/${name}`);
      expect(await file.exists()).toBe(true);
      total += file.size;
    }
    expect(total).toBeLessThan(80_000);
  });

  /** Retired with Nocturne. A stale face left in the package is bytes nobody notices. */
  test('the retired faces are gone', async () => {
    expect(tokens).not.toContain('inter-wordmark');
    for (const name of ['inter-wordmark.woff2', 'archivo-wordmark.woff2']) {
      expect(await Bun.file(`${import.meta.dir}/../../public/fonts/${name}`).exists()).toBe(false);
    }
  });
});

describe('the tokens that screens actually use', () => {
  const token = (name: string) => tokens.split(`${name}:`)[1]?.split(';')[0] ?? '';

  test('the UI face is Archivo, with a system fallback', () => {
    expect(token('--ck-font')).toContain('Archivo');
    // `font-display: swap` means a cold popup paints in the fallback first, so there has
    // to be one and it has to be a real face rather than the generic default.
    expect(token('--ck-font')).toContain('system-ui');
  });

  test('the wordmark is the UI face, not a face of its own any more', () => {
    expect(token('--ck-font-wordmark')).toContain('var(--ck-font)');
    expect(token('--ck-font-wordmark')).not.toContain('Inter');
  });

  /** Mono is not decoration: it is how a measured number is told apart from a sentence. */
  test('there is a mono token for measured values', () => {
    expect(token('--ck-font-mono')).toContain('JetBrains Mono');
    expect(token('--ck-font-mono')).toContain('monospace');
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
