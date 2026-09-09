/**
 * Which palette the document wears, and who decides.
 *
 * **Dark is the default.** It was light for two days, on the founder's call after seeing
 * Nocturne applied; the 2026-09-09 redesign reverses that deliberately. The new palette
 * is built dark-first and the light set is derived from it, so arriving on light would be
 * arriving on the derived one. Light is one tap away and is a complete palette, not a
 * filter.
 *
 * Three states, not two. `system` follows the OS and is what someone who has expressed no
 * opinion gets; `light` and `dark` are opinions, and an opinion outranks the OS until it
 * is taken back. Resolving here rather than in a media query keeps one copy of each
 * palette in CSS — two copies drift.
 */
export type Theme = 'light' | 'dark';
export type ThemeChoice = Theme | 'system';

/** Not secret, and not key material: a preference, in the same store as the username. */
export const THEME_KEY = 'cypherkey.theme';

type MediaQuery = {
  matches: boolean;
  addEventListener?: (t: 'change', fn: () => void) => void;
  removeEventListener?: (t: 'change', fn: () => void) => void;
};
type Win = { matchMedia?: (q: string) => MediaQuery };
type Doc = { documentElement: { dataset: Record<string, string | undefined> } };

/**
 * What the OS asks for.
 *
 * A context with no `matchMedia` — a test, an options page preview — lands on the
 * product's own default rather than on whichever branch happens to be written first.
 * That default is dark, so only an OS that explicitly asks for light gets it.
 */
export function systemTheme(win: Win): Theme {
  return win.matchMedia?.('(prefers-color-scheme: light)').matches === true ? 'light' : 'dark';
}

/** The palette a choice resolves to right now. */
export function resolveTheme(choice: ThemeChoice, win: Win): Theme {
  return choice === 'system' ? systemTheme(win) : choice;
}

/** Reads a stored choice, treating anything unrecognised as no choice at all. */
export function parseChoice(value: unknown): ThemeChoice {
  /*
    Unrecognised means "no choice made", and that falls to dark rather than to system.

    Defaulting to `system` would make the product's appearance depend on a setting the
    user never made here, and would hand a light-mode desktop the derived palette rather
    than the designed one. Dark is the product's default; `system` is one of the three
    things a user can ask for -- a default, not an absence.
  */
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'dark';
}

/** Stamps the palette on the root. The only place the attribute is written. */
export function stampTheme(doc: Doc, theme: Theme): void {
  doc.documentElement.dataset.theme = theme;
}

/**
 * Applies a choice and keeps it in step with the OS while the choice is `system`.
 *
 * Returns an unsubscribe. Calling it again with a new choice is how the control works:
 * the caller owns the choice, this owns the document.
 */
export function applyTheme(doc: Doc, win: Win, choice: ThemeChoice = 'dark'): () => void {
  const set = () => stampTheme(doc, resolveTheme(choice, win));
  set();

  // Only `system` tracks the OS. An explicit choice that moved when the OS did would not
  // be a choice.
  if (choice !== 'system') return () => {};
  const query = win.matchMedia?.('(prefers-color-scheme: dark)');
  if (query?.addEventListener === undefined) return () => {};
  query.addEventListener('change', set);
  return () => query.removeEventListener?.('change', set);
}
