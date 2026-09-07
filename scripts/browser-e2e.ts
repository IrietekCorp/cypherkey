/**
 * Onboarding, in a real Chrome, against a real server.
 *
 * `scripts/e2e.ts` proves the protocol: it drives `core/client` against the Hono app
 * in-process, with an injected `fetch` and an injected clock. That is the right test for
 * the crypto and the routes, and it is blind by construction to everything between the
 * library and a person -- because it substitutes exactly the pieces that break.
 *
 * Four production bugs in one evening got through it and through 1,097 unit tests:
 *
 *   - `globalThis.fetch` passed on unbound. Browsers enforce the receiver and throw
 *     "Illegal invocation"; Bun and Node do not, so every test passed.
 *   - The deployed server mounted only `/healthz`, because the entrypoint called
 *     `createApp({ db })` without a config. The e2e builds its own app, so it never
 *     touched the entrypoint.
 *   - Capture was armed by `onFocus`, and Enter submits without leaving the field, so
 *     the second passphrase attempt was never recorded. There was no browser to notice.
 *   - `window.print()` from a popup silently does nothing.
 *
 * This closes that gap. It runs the **production entrypoint** -- `server/src/index.ts`,
 * the same file the container runs -- and loads the built extension into Chrome, so the
 * things it substitutes are only the database (a scratch SQLite file) and the host.
 *
 * It deliberately does NOT run against api.cypherkey.io: signing up creates a real
 * account with real Argon2id cost on every run, and a test that writes to production is
 * a test people learn to skip.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';
import { DEV_EXTENSION_ID } from '../extension/manifest';

const EXTENSION_DIR = join(import.meta.dir, '..', 'extension', '.output', 'chrome-mv3');
const PORT = Number(Bun.env.BROWSER_E2E_PORT ?? 8791);
const API = `http://127.0.0.1:${PORT}`;
/** Argon2id at production cost, eight times, is not what this is testing. */
const JWT_SECRET = 'browser-e2e-secret-not-used-in-production-32b';

/** Chrome, wherever this machine keeps it. CI sets CHROME_PATH. */
function chromePath(): string {
  const candidates = [
    Bun.env.CHROME_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((c): c is string => c !== undefined && c !== '');
  const found = candidates.find((c) => existsSync(c));
  if (found === undefined) {
    throw new Error(
      `no Chrome found. Tried:\n  ${candidates.join('\n  ')}\nSet CHROME_PATH to override.`,
    );
  }
  return found;
}

let step = 0;
const ok = (what: string) => {
  step += 1;
  console.log(`  ${String(step).padStart(2, ' ')}. ✓ ${what}`);
};

async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main(): Promise<void> {
  if (!existsSync(EXTENSION_DIR)) {
    throw new Error(
      [
        `no extension build at ${EXTENSION_DIR}.`,
        'Build it pointed at this server first:',
        `  VITE_CYPHERKEY_API=${API} bun run build:extension`,
      ].join('\n'),
    );
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'ck-browser-e2e-'));
  const dbPath = join(dataDir, 'browser-e2e.db');

  console.log('\ncypherkey browser e2e — real Chrome, real server\n');

  // The production entrypoint, not a hand-built app. A server that mounts only
  // /healthz fails here the way it failed in production.
  const server = spawn('bun', ['server/src/index.ts'], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: `sqlite://${dbPath}`,
      JWT_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog: string[] = [];
  server.stdout?.on('data', (d: Buffer) => serverLog.push(d.toString()));
  server.stderr?.on('data', (d: Buffer) => serverLog.push(d.toString()));

  let browser: Browser | undefined;
  try {
    await waitFor('the server to answer /healthz', async () => {
      try {
        const res = await fetch(`${API}/healthz`);
        return res.ok;
      } catch {
        return false;
      }
    });
    ok('the production entrypoint started and /healthz answers');

    // Migrations are a deploy step, never a boot step (A-15), so run them here.
    const migrate = spawn('bun', ['server/src/db/migrate-cli.ts'], {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, DATABASE_URL: `sqlite://${dbPath}`, JWT_SECRET },
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      migrate.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`migrate exited ${code}`)),
      );
    });

    // The route the deployed server did not have. Checked before Chrome is involved,
    // so an unmounted API fails with a clear message instead of a UI symptom.
    const salt = await fetch(`${API}/auth/salt?username=nobody`);
    if (salt.status !== 200) {
      throw new Error(`/auth/salt returned ${salt.status} — the API routes are not mounted`);
    }
    await salt.json();
    ok('the API is mounted, and /auth/salt returns JSON');

    browser = await puppeteer.launch({
      executablePath: chromePath(),
      // Extensions need a real browser: the headless shell cannot load them.
      headless: Bun.env.BROWSER_E2E_HEADED !== '1',
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        '--no-sandbox',
        '--no-first-run',
      ],
    });

    /*
      The id is pinned by the dev build's manifest key rather than discovered.

      Discovery meant waiting for the MV3 service-worker target, which starts on demand
      and is not reliably registered by the time a test looks for it: locally it was
      there, on a CI runner it never appeared and the run timed out having proved
      nothing. A fixed id removes the race entirely -- opening the popup is what starts
      the worker anyway.
    */
    const extensionId = DEV_EXTENSION_ID;
    ok(`the extension loaded with a pinned id (${extensionId})`);

    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'load' });
    await page.waitForSelector('[data-testid="consent"]', { timeout: 30_000 });
    ok('the popup rendered the onboarding screen');

    // Consent first: it sits above the passphrase precisely so ticking it cannot blur
    // a captured sample.
    await page.click('[data-testid="consent"]');
    await page.type('[data-testid="username"]', `browser-${Date.now()}`);
    await page.type('[data-testid="email"]', 'browser-e2e@cypherkey.test');
    ok('consent, username and email accepted');

    const PASSPHRASE = 'correct horse battery';
    const light = '[data-testid="rhythm-light"]';

    await page.focus('[data-testid="passphrase"]');
    await waitFor('the light to arm', async () =>
      (await page.$eval(light, (el) => el.parentElement?.textContent ?? '')).includes('Ready'),
    );
    ok('focusing the field armed capture — the light reads Ready');

    // Real key events with real gaps: this is the rhythm being measured.
    await page.keyboard.type(PASSPHRASE, { delay: 45 });
    const pulses = await page.$eval(light, (el) => el.getAttribute('data-pulses'));
    if (Number(pulses) !== PASSPHRASE.length) {
      throw new Error(`the light counted ${pulses} keystrokes, expected ${PASSPHRASE.length}`);
    }
    ok(`capture recorded all ${PASSPHRASE.length} keystrokes`);

    // Enter, not the button. Enter never leaves the field, which is what left the
    // second attempt unarmed.
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => document.body.textContent?.includes('Type it again') === true,
      { timeout: 30_000 },
    );
    ok('Enter accepted the first passphrase and asked for it again');

    await waitFor('the second attempt to be armed without re-focusing', async () =>
      (await page.$eval(light, (el) => el.parentElement?.textContent ?? '')).includes('Ready'),
    );
    ok('the second attempt is armed with no click away and back');

    await page.keyboard.type(PASSPHRASE, { delay: 45 });
    await page.keyboard.press('Enter');

    // Signup runs Argon2id in a worker and then talks to the server. This is the step
    // that failed on an unbound fetch and on a server with no routes.
    await page.waitForFunction(() => document.body.textContent?.includes('Recovery Kit') === true, {
      timeout: 120_000,
    });
    ok('signup completed against the real server — the Recovery Kit screen is showing');

    const kit = await page.$eval('[data-testid="kit-code"]', (el) => el.textContent ?? '');
    if (kit.trim().length === 0) throw new Error('the Recovery Kit is empty');
    ok(`the Kit was issued (${kit.trim().length} characters)`);

    // The confirmation reads positions off a ruler now, so the test reads them the same
    // way a person does rather than recomputing them.
    const asked = await page.$$eval('[data-testid="position-label"]', (nodes) =>
      nodes.map((n) => Number((n.textContent ?? '').replace('#', '').trim())),
    );
    const symbols = [...kit.trim().replace(/-/g, '')];
    for (const [i, position] of asked.entries()) {
      await page.type(`[data-testid="answer-${i}"]`, symbols[position - 1] ?? '');
    }
    ok(`answered the ${asked.length} confirmation positions from the on-screen ruler`);

    await page.click('[data-testid="confirm"]');
    await page.waitForFunction(
      () => document.body.textContent?.includes('That does not match') !== true,
      { timeout: 15_000 },
    );
    ok('the Kit confirmation was accepted');

    if (consoleErrors.length > 0) {
      throw new Error(`the page logged errors:\n  ${consoleErrors.join('\n  ')}`);
    }
    ok('no console or page errors throughout');

    console.log(`\n  ${step} steps passed in Chrome\n`);
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
    if (process.exitCode !== undefined && process.exitCode !== 0) {
      console.error(`\nserver output:\n${serverLog.join('')}`);
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await main().catch((err: unknown) => {
  console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
process.exit(0);
