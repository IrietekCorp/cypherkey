/**
 * Screenshots the popup's screens against the built stylesheet.
 *
 * `bun run design-preview` after a `build:extension`. Writes a PNG rather than opening a
 * window, so it works the same on a laptop and in CI if it is ever wanted there.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const OUT = join(import.meta.dir, '..', 'extension', '.output', 'chrome-mv3');
const SHOT = Bun.env.DESIGN_PREVIEW_OUT ?? join(import.meta.dir, '..', 'design-preview.png');

function chromePath(): string {
  const candidates = [
    Bun.env.CHROME_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((c): c is string => c !== undefined && c !== '');
  const found = candidates.find((c) => existsSync(c));
  if (found === undefined) throw new Error('no Chrome found; set CHROME_PATH');
  return found;
}

const css = (await Array.fromAsync(new Bun.Glob('assets/popup-*.css').scan(OUT)))[0];
if (css === undefined) {
  throw new Error(`no built stylesheet in ${OUT}. Run: bun run build:extension`);
}

const bundle = await Bun.build({
  entrypoints: [join(import.meta.dir, 'design', 'frames.tsx')],
  target: 'browser',
  minify: false,
});
if (!bundle.success) throw new AggregateError(bundle.logs, 'preview bundle failed');
const js = await (bundle.outputs[0] as { text(): Promise<string> }).text();
const styles = await Bun.file(join(OUT, css)).text();

/*
  Served rather than inlined. A bundle pasted into a `<script>` tag ends that tag at the
  first `</script>` inside a string literal, and the rest of the file renders as visible
  text -- which is exactly what the first attempt produced.
*/
const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="/popup.css">
<style>body{margin:0;padding:24px;background:#0b0d16}</style></head>
<body><div id="frames" style="display:flex;gap:24px;flex-wrap:wrap"></div>
<script type="module" src="/frames.js"></script></body></html>`;

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/frames.js') {
      return new Response(js, { headers: { 'content-type': 'text/javascript' } });
    }
    if (path === '/popup.css') {
      return new Response(styles, { headers: { 'content-type': 'text/css' } });
    }
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  },
});

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1720, height: 700, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'networkidle0' });
await page.screenshot({ path: SHOT, fullPage: true });
await browser.close();
server.stop();
console.log(`wrote ${SHOT}`);
