import { createRoot } from 'react-dom/client';
import { THEME_KEY, parseChoice, resolveTheme, stampTheme } from '../../src/design/theme';
import '../popup/style.css';

/*
  The palette, before the first paint, exactly as the popup does it.

  This is a second document with its own root element, so it needs its own stamp — the
  popup's runs in a window this one cannot see. Light first, corrected from storage a
  moment later; the choice is shared, so the two surfaces never disagree for long.
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

/**
 * Settings are M2-14, which also carries the A-17 server change.
 *
 * `Settings.tsx` is written and tested; what it does not have here is an access token.
 * Every control on it that weakens protection is an authenticated request, and the
 * session lives in the popup's `chrome.storage.session` — a separate document with no
 * claim on it. Wiring that up is the rest of M2-14, and it is a session-plumbing change,
 * not a styling one.
 *
 * Until then this page says so rather than presenting controls that would fail, and the
 * Profile's link lands somewhere that reads as finished-but-empty rather than broken.
 */
const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <main
      className="ck-app flex flex-col"
      style={{ padding: 'var(--ck-s6)', gap: 'var(--ck-s5)', maxWidth: 620, minHeight: '100vh' }}
    >
      <header className="flex items-baseline" style={{ gap: 'var(--ck-s2)' }}>
        <span className="ck-wordmark">CypherKey</span>
        <h1 className="ck-h1 ck-muted">settings</h1>
      </header>

      <section className="card flex flex-col" style={{ gap: 'var(--ck-s2)' }}>
        <h2 className="ck-h2">Not open yet</h2>
        <p className="ck-small ck-muted">
          Strictness, devices, pausing rhythm checks and your Recovery Kit will live here. They need
          an unlocked session, which this page cannot reach yet — open the extension and use the
          profile screen in the meantime.
        </p>
      </section>
    </main>,
  );
}
