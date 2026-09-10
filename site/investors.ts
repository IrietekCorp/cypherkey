import { initTheme } from './theme';

initTheme();

/**
 * The deck is a page you print as often as you scroll it.
 *
 * `@media print` in the stylesheet does the layout work; this is only the button, so
 * someone reading on a laptop can hand over a PDF without hunting through a menu.
 */
document.querySelector('[data-print]')?.addEventListener('click', () => window.print());
