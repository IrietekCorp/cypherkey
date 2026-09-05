import { defineContentScript } from 'wxt/utils/define-content-script';
import { isPunycodeHost, showWarning } from './banner';
import { detectLoginFields, looksLikeSignIn } from './detect';

/**
 * The content script.
 *
 * It detects and warns; it does not fill on its own. A fill happens only when the user
 * asks for one through the popup, because a script that fills on sight would put a
 * credential on the page before anyone has looked at the address bar.
 *
 * What it does eagerly is the one thing that must not wait: warning about a punycode
 * host, which has to be on screen *before* the user starts typing.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',

  main() {
    // Only the top frame. `decideFill` refuses a subframe anyway, but there is no
    // reason to run detection in a hundred ad iframes to be told so a hundred times.
    if (window.top !== window.self) return;

    const forms = detectLoginFields(document);
    if (forms.length === 0) return;

    // The saved host is irrelevant here — the page is a lookalike whatever is in the
    // vault — so this needs no vault lookup and, importantly, no `tldts`. Importing the
    // public suffix list would put ~250 KB into every page the user visits.
    if (isPunycodeHost(location.hostname)) showWarning(document);

    void looksLikeSignIn(forms);
  },
});
