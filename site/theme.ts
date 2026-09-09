/**
 * The palette control in the nav.
 *
 * Two states, not three. The extension keeps a System option because it is a tool you
 * live in and it should follow the desktop it lives on; a marketing page is read once,
 * and a visitor who wants the other palette wants it now rather than wanting to explain
 * a preference. The label shows the palette you would *get*, which is the only labelling
 * of a toggle that never has to be read twice.
 *
 * `index.html` stamps the same value inline before first paint. This module re-stamps it
 * a moment later and owns every change after that.
 */

export const THEME_KEY = 'ck-theme';

export type Theme = 'dark' | 'light';

/** Dark is the default. Anything unrecognised, including nothing, resolves to it. */
export function parseTheme(value: unknown): Theme {
  return value === 'light' ? 'light' : 'dark';
}

export function storedTheme(store: Pick<Storage, 'getItem'> = localStorage): Theme {
  try {
    return parseTheme(store.getItem(THEME_KEY));
  } catch {
    // Private browsing, or storage denied. Not a reason to render nothing.
    return 'dark';
  }
}

export function stampTheme(doc: Document, theme: Theme): void {
  doc.documentElement.dataset.theme = theme;
}

/**
 * Wires every toggle on the page.
 *
 * Every page carries one in its nav, and they are queried rather than passed in so a new
 * page cannot forget to register its own.
 */
export function initTheme(doc: Document = document): void {
  let theme = storedTheme();
  const buttons = [...doc.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')];

  const apply = (next: Theme) => {
    theme = next;
    stampTheme(doc, next);
    for (const button of buttons) {
      // The label is the destination, not the current state.
      button.textContent = next === 'dark' ? 'LIGHT' : 'DARK';
      button.setAttribute(
        'aria-label',
        `Switch to the ${next === 'dark' ? 'light' : 'dark'} palette`,
      );
    }
  };

  apply(theme);

  for (const button of buttons) {
    button.addEventListener('click', () => {
      const next: Theme = theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // The choice still applies to this page; it just will not survive a reload.
      }
      apply(next);
    });
  }
}
