import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { isPunycodeHost, showWarning } from './content/banner';
import { detectLoginFields, looksLikeSignIn } from './content/detect';

/**
 * The injected filler.
 *
 * **Unlisted on purpose.** It is not declared in `content_scripts` and never runs on
 * its own. The extension holds `activeTab` rather than `<all_urls>`, so this is
 * injected into one tab, at the moment the user asks for a fill, and has no access to
 * any page they have not pointed it at.
 *
 * The cost of that posture, stated plainly: there is no longer a script watching every
 * page, so **the punycode banner cannot appear before the user starts typing**. It
 * appears when a fill is requested, which is still before any credential is released,
 * but it is later than it was. A page that steals a hand-typed password on a lookalike
 * domain is no longer something this extension can warn about in advance.
 */
export default defineUnlistedScript(() => {
  if (window.top !== window.self) return;

  // The warning goes up before anything is looked for, so a lookalike page is called
  // out even if it has no recognisable form.
  if (isPunycodeHost(location.hostname)) {
    showWarning(document);
    return;
  }

  const forms = detectLoginFields(document);
  if (forms.length === 0 || !looksLikeSignIn(forms)) return;

  // The credential itself arrives by message from the popup, which has already run
  // `decideFill` against this tab's URL. Nothing is filled by this script alone.
});
