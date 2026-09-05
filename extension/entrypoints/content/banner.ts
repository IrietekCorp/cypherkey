/**
 * The warning shown when a fill is refused for a reason the user needs to know about.
 *
 * Only `punycode` earns a banner. A different site or a subframe is an ordinary "not
 * here" and interrupting the page for it would train people to dismiss the banner
 * without reading — which is exactly when the one that matters arrives.
 *
 * Deliberately free of `tldts`. This module runs in a content script on every page the
 * user visits, and the public suffix list is ~250 KB — a quarter of a megabyte injected
 * into every page to answer a question that is a substring check. The registrable-domain
 * matching that does need it lives in `fill.ts`, which only the popup loads.
 */

export const PUNYCODE_WARNING =
  'This address uses characters that can look identical to ordinary letters, so CypherKey will not fill anything here. Check the address bar before typing a password.';

/**
 * True when the host renders as letters that may be visually identical to Latin ones.
 *
 * The user cannot tell by looking, which is the whole problem: no comparison against a
 * saved host is evidence of anything on such a page.
 */
export function isPunycodeHost(host: string): boolean {
  return host.toLowerCase().includes('xn--');
}

const BANNER_ID = 'cypherkey-warning';

/**
 * Shows the banner, once.
 *
 * It is deliberately plain DOM in a shadow root: the page's own stylesheet must not be
 * able to hide, restyle or impersonate a security warning, and a page that could would
 * make the warning worse than nothing.
 */
export function showWarning(doc: Document, message = PUNYCODE_WARNING): void {
  if (doc.getElementById(BANNER_ID) !== null) return;

  const host = doc.createElement('div');
  host.id = BANNER_ID;
  host.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:2147483647;all:initial;display:block';

  const shadow = host.attachShadow({ mode: 'closed' });
  const bar = doc.createElement('div');
  bar.setAttribute('role', 'alert');
  bar.style.cssText = [
    'font:14px/1.4 system-ui,sans-serif',
    'background:#7f1d1d',
    'color:#fff',
    'padding:10px 14px',
    'display:flex',
    'gap:12px',
    'align-items:center',
  ].join(';');

  const text = doc.createElement('span');
  text.textContent = message;
  const dismiss = doc.createElement('button');
  dismiss.textContent = 'Dismiss';
  dismiss.style.cssText =
    'font:inherit;background:transparent;color:#fff;border:1px solid #fff;border-radius:4px;padding:2px 8px;cursor:pointer';
  dismiss.addEventListener('click', () => host.remove());

  bar.append(text, dismiss);
  shadow.append(bar);
  doc.body.append(host);
}

/** Removes the banner if one is showing. Used when navigating within a page. */
export function hideWarning(doc: Document): void {
  doc.getElementById(BANNER_ID)?.remove();
}
