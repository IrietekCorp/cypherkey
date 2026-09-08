/**
 * Which palette the document wears.
 *
 * Dark is the default the style guide specifies; light is the same tokens remapped on
 * `[data-theme]`. Resolving it here rather than in a media query keeps one copy of the
 * light palette in CSS -- two copies drift -- and leaves a user preference able to
 * override the OS later without restructuring the stylesheet.
 */
export type Theme = 'dark' | 'light';

/** The OS preference, defaulting to the guide's dark when nothing says otherwise. */
export function preferredTheme(win: { matchMedia?: (q: string) => { matches: boolean } }): Theme {
  return win.matchMedia?.('(prefers-color-scheme: light)').matches === true ? 'light' : 'dark';
}

/** Stamps the theme and keeps it in step with the OS. Returns an unsubscribe. */
export function applyTheme(
  doc: { documentElement: { dataset: Record<string, string | undefined> } },
  win: {
    matchMedia?: (q: string) => {
      matches: boolean;
      addEventListener?: (t: 'change', fn: () => void) => void;
      removeEventListener?: (t: 'change', fn: () => void) => void;
    };
  },
): () => void {
  const set = () => {
    doc.documentElement.dataset.theme = preferredTheme(win);
  };
  set();

  const query = win.matchMedia?.('(prefers-color-scheme: light)');
  if (query?.addEventListener === undefined) return () => {};
  query.addEventListener('change', set);
  return () => query.removeEventListener?.('change', set);
}
