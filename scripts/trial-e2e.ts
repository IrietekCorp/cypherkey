/**
 * The Rhythm Trial, played end to end in a real browser.
 *
 * The trial is the page that makes the product's claim, and it makes it with the real
 * `core/biometrics` maths rather than a demo re-implementation. That is the whole reason
 * it is convincing and it is exactly why it needs a test: a change to the tokenizer, the
 * feature ranges, the weights or the bands would break the demonstration silently, and
 * the first person to notice would be a stranger being told they typed like the owner.
 *
 * So this types eight consistent samples, then types badly on purpose, and asserts the
 * outcome the product is named for -- the intruder is refused and the owner passes. It
 * also asserts the thing that is easy to regress by accident: no score is ever printed.
 *
 * Needs a built site and a Chrome that will run a script. See `scripts/browser-e2e.ts`
 * for why that is not branded Google Chrome any more.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';

const ROOT = join(import.meta.dir, '..', 'site', 'dist');
const PORT = Number(Bun.env.TRIAL_E2E_PORT ?? 4321);
const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = join(ROOT, p);
    return existsSync(file) ? new Response(Bun.file(file)) : new Response('nf', { status: 404 });
  },
});

if (!existsSync(join(ROOT, 'demo.html'))) {
  server.stop();
  throw new Error(`no built site at ${ROOT}. Run: bun run build:site`);
}

const chrome = Bun.env.CHROME_PATH;
if (chrome === undefined || chrome === '') {
  server.stop();
  throw new Error(
    'set CHROME_PATH to a Chrome that loads scripts. Install one with:\n  bunx @puppeteer/browsers install chrome@stable',
  );
}

console.log('\ncypherkey — the Rhythm Trial, in a real browser\n');

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await page.setViewport({ width: 1440, height: 1000 });
await page.goto(`http://127.0.0.1:${PORT}/demo.html`, { waitUntil: 'load' });

let step = 0;
const ok = (s: string) => console.log(`  ${++step}. ✓ ${s}`);
const visible = (name: string) =>
  page.$eval(`[data-stage="${name}"]`, (el) => !(el as HTMLElement).hidden);

// Type with human-ish, *consistent* cadence so the profile is tight.
async function typePhrase(p: Page, text: string, jitter = 0) {
  for (const ch of text) {
    await p.keyboard.down(ch === ' ' ? 'Space' : (ch as never));
    await new Promise((r) => setTimeout(r, 70 + (Math.random() * 2 - 1) * jitter));
    await p.keyboard.up(ch === ' ' ? 'Space' : (ch as never));
    await new Promise((r) => setTimeout(r, 90 + (Math.random() * 2 - 1) * jitter));
  }
}

if (!(await visible('calibrate'))) throw new Error('calibrate not showing');
ok('the trial opens on calibrate');

const phrase = await page.$eval('[data-random-phrase]', (el) => el.textContent ?? '');
if (phrase.split(' ').length !== 4) throw new Error(`phrase looks wrong: ${phrase}`);
ok(`a four-word phrase was offered (${phrase})`);

await page.click('[data-begin]');
if (!(await visible('teach'))) throw new Error('did not advance to teach');
ok('begin moves to the teach stage');

for (let i = 1; i <= 8; i += 1) {
  await page.focus('[data-stage="teach"] [data-type-input]');
  await typePhrase(page, phrase, 6);
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 120));
}
if (!(await visible('forged'))) {
  const fb = await page.$eval('[data-stage="teach"] [data-feedback]', (el) => el.textContent);
  throw new Error(`profile never forged; feedback: ${fb}`);
}
ok('eight samples forged the profile');

const dims = await page.$eval('[data-stat-dims]', (el) => el.textContent ?? '');
const cons = await page.$eval('[data-stat-consistency]', (el) => el.textContent ?? '');
const tokens = phrase.length;
if (Number(dims) !== 3 * tokens + 5)
  throw new Error(`vector is ${dims}, expected 3n+5 = ${3 * tokens + 5}`);
ok(`the vector is 3n+5 (${dims} for n=${tokens}) and consistency reads ${cons}`);

await page.click('[data-to-intruder]');
if (!(await visible('intruder'))) throw new Error('no intruder stage');
ok('the intruder round opened');

// A different cadence: slower, and much more erratic. This is the stranger.
for (let i = 0; i < 3 && (await visible('intruder')); i += 1) {
  await page.focus('[data-stage="intruder"] [data-type-input]');
  for (const ch of phrase) {
    await page.keyboard.down(ch === ' ' ? 'Space' : (ch as never));
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 120));
    await page.keyboard.up(ch === ' ' ? 'Space' : (ch as never));
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 200));
  }
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 150));
}
if (!(await visible('you'))) throw new Error('never reached your turn');
ok('three intruder attempts were spent and it handed back');

await page.focus('[data-stage="you"] [data-type-input]');
await typePhrase(page, phrase, 6);
await page.keyboard.press('Enter');
await new Promise((r) => setTimeout(r, 200));
if (!(await visible('verdict'))) throw new Error('no verdict');
ok('your attempt produced a verdict');

const read = async (which: string) => ({
  band: await page.$eval(`[data-verdict="${which}"] [data-band]`, (el) => el.textContent ?? ''),
  head: await page.$eval(`[data-verdict="${which}"] [data-headline]`, (el) => el.textContent ?? ''),
});
const intruder = await read('intruder');
const you = await read('you');
console.log(`     intruder: ${intruder.band} — ${intruder.head}`);
console.log(`     you:      ${you.band} — ${you.head}`);
ok('both cards carry a band and a sentence');

if (/\d\.\d/.test(await page.$eval('.ck-stage-pane', (el) => el.textContent ?? ''))) {
  throw new Error('a decimal that looks like a score is on screen');
}
ok('no score is shown anywhere on the verdict');

await page.click('[data-strictness="strict"]');
await new Promise((r) => setTimeout(r, 100));
ok(`strictness re-evaluates without retyping (you: ${(await read('you')).band} at Strict)`);

/*
  Escape clears the box, and a voided sample does not leave text behind.

  The complaint this came from: a refused sample left the typed phrase sitting in the
  field, looking like progress that had already been thrown away, and the only way out
  was selecting it and deleting it by hand. Escape is the reset a keyboard reaches for.

  It costs the trial one Phantom Key — in the extension an Escape tap is a legitimate
  token — so Backspace carries that demonstration alone here.
*/
await page.click('[data-again-you]');
await page.focus('[data-stage="you"] [data-type-input]');
await typePhrase(page, 'not the phrase at all');
const beforeEscape = await page.$eval(
  '[data-stage="you"] [data-type-input]',
  (el) => (el as HTMLInputElement).value,
);
if (beforeEscape.length === 0) throw new Error('the typing never reached the field');
await page.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 120));

const afterEscape = await page.evaluate(() => {
  const input = document.querySelector('[data-stage="you"] [data-type-input]') as HTMLInputElement;
  return { value: input.value, focused: document.activeElement === input };
});
if (afterEscape.value !== '') throw new Error(`Escape left "${afterEscape.value}" in the field`);
if (!afterEscape.focused) throw new Error('Escape cleared the field but dropped focus');
ok('Escape clears the box and keeps the cursor in it');

// The reset must re-arm, or the next sample cannot be taken at all.
await typePhrase(page, phrase);
await page.keyboard.press('Enter');
await new Promise((r) => setTimeout(r, 200));
if (!(await visible('verdict'))) throw new Error('the sample after an Escape was not accepted');
ok('a sample typed after the reset is still measured');

// And a refused sample clears itself, which is where the complaint started.
await page.click('[data-again-you]');
await page.focus('[data-stage="you"] [data-type-input]');
await typePhrase(page, 'wrong phrase entirely');
await page.keyboard.press('Enter');
await new Promise((r) => setTimeout(r, 200));
const afterRefusal = await page.$eval(
  '[data-stage="you"] [data-type-input]',
  (el) => (el as HTMLInputElement).value,
);
if (afterRefusal !== '') throw new Error(`a refused sample left "${afterRefusal}" behind`);
ok('a refused sample does not leave its text in the box');

if (errors.length > 0) throw new Error(`console errors:\n  ${errors.join('\n  ')}`);
ok('no console errors through the whole trial');

await browser.close();
server.stop();
console.log(`\n  ${step} steps passed\n`);
