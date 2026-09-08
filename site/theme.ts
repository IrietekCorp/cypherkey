/**
 * The site's appearance control.
 *
 * Same three states as the extension — light, dark, system — so the two products behave
 * the same way, and the same reasoning: `system` is a real answer, and a two-state toggle
 * makes a visitor with no opinion invent one.
 *
 * The choice is a `localStorage` string. Nothing here is private; a marketing page that
 * remembers you prefer dark is not tracking you.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = 'cypherkey.theme';

function parse(value: unknown): ThemeChoice {
  // No choice made falls to light, not to system: defaulting to the OS would show a dark
  // page to anyone on a dark desktop, which is the look this moved away from.
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'light';
}

function stored(): ThemeChoice {
  try {
    return parse(localStorage.getItem(KEY));
  } catch {
    // Private browsing, or storage blocked. Take the default and say nothing.
    return 'light';
  }
}

function resolve(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches === true ? 'dark' : 'light';
}

function stamp(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = resolve(choice);
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute(
      'aria-pressed',
      String(button.getAttribute('data-theme-choice') === choice),
    );
  }
}

/** Wires the control and keeps `system` in step with the OS. */
export function initTheme(): void {
  let choice = stored();
  stamp(choice);

  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.addEventListener('click', () => {
      choice = parse(button.getAttribute('data-theme-choice'));
      try {
        localStorage.setItem(KEY, choice);
      } catch {
        // The choice still applies for this visit; it just will not be remembered.
      }
      stamp(choice);
    });
  }

  // Only `system` tracks the OS: an explicit choice that moved when the OS did would not
  // be a choice.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (choice === 'system') stamp(choice);
  });
}
