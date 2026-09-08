import { createRoot } from 'react-dom/client';
import { THEME_KEY, parseChoice, resolveTheme, stampTheme } from '../../src/design/theme';
import { App } from './App';
import './style.css';

/*
  Stamped before the first render, from storage, so no frame paints on the wrong ground.

  Reading storage is async and painting is not, so the default palette is applied
  immediately and corrected if a stored choice disagrees. Light is the default, so the
  worst case is a light flash before dark -- not a dark flash before light, which is the
  one people notice.

  This stamps and does not subscribe: `App` owns the live choice and keeps `system` in
  step with the OS. Two subscriptions would stamp the same value twice and one of them
  would never be torn down.
*/
const stamp = (choice: Parameters<typeof resolveTheme>[0]) =>
  stampTheme(document, resolveTheme(choice, window));

stamp('light');
void (async () => {
  const chrome = (
    globalThis as {
      chrome?: { storage?: { local?: { get(k: string): Promise<Record<string, unknown>> } } };
    }
  ).chrome;
  const stored = await chrome?.storage?.local?.get(THEME_KEY);
  if (stored !== undefined) stamp(parseChoice(stored[THEME_KEY]));
})();

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<App />);
