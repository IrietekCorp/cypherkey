import { createRoot } from 'react-dom/client';
import { API_BASE_URL } from '../../src/config';
import { THEME_KEY, parseChoice, resolveTheme, stampTheme } from '../../src/design/theme';
import { sessionArea } from '../../src/resume';
import { createExtensionSession } from '../../src/session';
import { localArea, memoryArea } from '../../src/storage';
import { OptionsApp } from './OptionsApp';
import '../popup/style.css';

/*
  The palette, before the first paint, exactly as the popup does it.

  This is a second document with its own root element, so it needs its own stamp — the
  popup's runs in a window this one cannot see. Dark first, corrected from storage a
  moment later; the choice is shared, so the two surfaces never disagree for long.
*/
const stamp = (choice: Parameters<typeof resolveTheme>[0]) =>
  stampTheme(document, resolveTheme(choice, window));

stamp('dark');
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
 * Settings (M2-14), on a session this document has to resume rather than being handed.
 *
 * `OptionsApp` owns that; everything here is the wiring it needs. The KDF Worker is
 * real rather than a stub because the A-17 proof is an Argon2id pass at m=64 MiB —
 * running it on this thread would freeze the page mid-keystroke, which is the same
 * reason the popup does not.
 */
const root = document.getElementById('root');
if (root !== null) {
  const session = createExtensionSession({
    baseUrl: API_BASE_URL,
    // The same `storage.local` the popup writes: the device key and the user's salt
    // live there, and this page needs both to sign a request and to prove a passphrase.
    area: localArea() ?? memoryArea(),
    worker: new Worker(new URL('../../src/kdf-worker.ts', import.meta.url), { type: 'module' }),
  });
  createRoot(root).render(<OptionsApp session={session} memory={sessionArea()} />);
}
