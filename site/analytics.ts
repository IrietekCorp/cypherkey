/**
 * Google Analytics 4.
 *
 * **Why this is a module rather than the inline snippet Google hands out.** The site's
 * CSP is `script-src 'self'` with no `unsafe-inline`, so every inline script has to be
 * named in the deployed header by `sha256-`. There is exactly one of those — the
 * pre-paint theme stamp — and `site/csp.test.ts` guards that there is exactly one,
 * because a header carrying several hashes is a header where the forgotten one fails
 * silently. Loading the same code from `/analytics.ts` costs nothing and needs no hash.
 *
 * The tag it injects is still third-party, so the header does have to admit
 * `googletagmanager.com` in `script-src` and Google's collection endpoints in
 * `connect-src` and `img-src`. That is the whole of the CSP change.
 *
 * **This is deliberately not on the Rhythm Trial.** `/demo.html` tells the visitor, in
 * the rail, that it has made `network requests 0`, and the argument the page is making
 * is that nothing about their typing leaves the browser. A beacon on that page makes the
 * claim false in the one place a sceptical visitor is most likely to open devtools and
 * check. The trial is the page that has to be true; the marketing pages around it are
 * where the measurement belongs.
 */

const MEASUREMENT_ID = 'G-J20MXLEEJV';

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

window.dataLayer = window.dataLayer ?? [];

/** Pushes the argument list itself, which is the shape gtag.js reads. */
function gtag(...args: unknown[]): void {
  window.dataLayer?.push(args);
}

gtag('js', new Date());
gtag('config', MEASUREMENT_ID);

const tag = document.createElement('script');
tag.async = true;
tag.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
document.head.append(tag);

export {};
