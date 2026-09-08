import { describe, expect, test } from 'bun:test';

/**
 * The font strategy, pinned.
 *
 * The style guide says "Inter throughout". The extension cannot afford that: a latin
 * subset is 30-40 KB against a 150 KB eager popup already at 77% before any typeface. So
 * Inter is reserved for the wordmark and subset to its seven letters, the UI runs on the
 * platform's own interface face, and "Inter throughout" applies to cypherkey.io.
 *
 * These assert the arrangement rather than describe it, because the failure mode is
 * quiet: a later edit that widens `--ck-font` to Inter renders every screen in a face
 * with seven glyphs, and every other character falls back silently.
 */
const tokens = await Bun.file(`${import.meta.dir}/tokens.css`).text();

describe('the wordmark face', () => {
  test('is bundled, not fetched — MV3 admits no remote font', () => {
    const face = tokens.slice(
      tokens.indexOf('@font-face'),
      tokens.indexOf('}', tokens.indexOf('@font-face')),
    );
    expect(face).toContain('/fonts/inter-wordmark.woff2');
    expect(face).not.toContain('fonts.googleapis.com');
    expect(face).not.toContain('fonts.gstatic.com');
  });

  test('is subset to the letters of "CypherKey" and nothing else', () => {
    // C K e h p r y. A face that carried more would cost more, and nothing else uses it.
    for (const point of ['U+43', 'U+4b', 'U+65', 'U+68', 'U+70', 'U+72', 'U+79']) {
      expect(tokens).toContain(point);
    }
  });

  test('the file is small enough to be a wordmark rather than a UI face', async () => {
    const file = Bun.file(`${import.meta.dir}/../../public/fonts/inter-wordmark.woff2`);
    expect(await file.exists()).toBe(true);
    // A full latin Inter is 30-40 KB. Anything approaching that here means the subset
    // was lost in a re-export, and the eager budget goes with it.
    expect(file.size).toBeLessThan(8_000);
  });
});

describe('the UI face', () => {
  test('is the platform stack, and never Inter', () => {
    const ui = tokens.split('--ck-font:')[1]?.split(';')[0] ?? '';
    expect(ui).toContain('system-ui');
    // The whole point: a seven-glyph face must never be asked to render a screen.
    expect(ui).not.toContain('Inter');
  });

  test('the wordmark token asks for Inter first, then falls back to the UI stack', () => {
    const wordmark = tokens.split('--ck-font-wordmark:')[1]?.split(';')[0] ?? '';
    expect(wordmark).toContain('Inter');
    expect(wordmark).toContain('var(--ck-font)');
  });
});
