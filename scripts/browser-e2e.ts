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
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
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

    const consoleErrors: string[] = [];
    /**
     * Every document this run opens, not just the first.
     *
     * The listener used to be attached to the popup alone, so anything the reopened
     * popup or the options page logged went unread -- and the options page is the one
     * that builds a Worker and mounts React outside the popup, which is exactly where a
     * silent failure would hide.
     */
    const watch = <T extends Page>(target: T): T => {
      target.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      target.on('pageerror', (e) => consoleErrors.push(String(e)));
      return target;
    };

    const page = watch(await browser.newPage());

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

    // ---- enrolment, and surviving a closed popup -----------------------------
    await page.waitForFunction(() => document.body.textContent?.includes('of 8') === true, {
      timeout: 30_000,
    });
    ok('enrolment asked for the first of eight samples');

    const submitted = async () =>
      Number(
        (await page.$eval('main', (el) => el.textContent ?? '')).match(/(\d+) of 8/)?.[1] ?? '-1',
      );

    await page.focus('[data-testid="passphrase"]');
    await page.keyboard.type(PASSPHRASE, { delay: 45 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.body.textContent?.includes('1 of 8') === true, {
      timeout: 60_000,
    });
    ok('the first sample was accepted');

    // The bug this guards: capture is armed by `onFocus` and neither Enter nor the
    // button moves focus, so nothing re-armed and every later sample went nowhere.
    await waitFor('the next sample to be armed without re-focusing', async () =>
      (await page.$eval(light, (el) => el.parentElement?.textContent ?? '')).includes('Ready'),
    );
    await page.keyboard.type(PASSPHRASE, { delay: 45 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.body.textContent?.includes('2 of 8') === true, {
      timeout: 60_000,
    });
    ok('a second sample was accepted without touching the field again');

    /*
      Close the popup and open it again -- which is what a person does, and what used to
      throw the account away: session storage was in memory, so every open started
      onboarding afresh for an account that already existed.
    */
    const before = await submitted();
    await page.close();
    const reopened = watch(await browser.newPage());
    await reopened.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'load' });
    await reopened.waitForFunction(
      () => document.body.textContent?.includes('Checking this device') !== true,
      { timeout: 30_000 },
    );
    const text = await reopened.$eval('main', (el) => el.textContent ?? '');
    if (text.includes('Create your CypherKey')) {
      throw new Error('reopening the popup started onboarding again for an existing account');
    }
    ok('reopening the popup did not start onboarding again');

    if (!text.includes('Unlock') && !text.includes('passphrase')) {
      throw new Error(`reopened to an unexpected screen: ${text.slice(0, 120)}`);
    }
    ok(`the reopened popup offers to unlock the existing account (${before} of 8 already sent)`);

    /*
      A resumable session, which is the point of M2-18.

      Enrolment is not finished in this run, so there is no unlocked vault to resume --
      what is asserted here is the mechanism: the snapshot lives in `storage.session`,
      which the browser wipes on shutdown, and never in `storage.local`, which is disk.
      A vault key on disk means a stolen laptop opens the vault with no passphrase.
    */
    const stored = await reopened.evaluate(async () => {
      const api = (globalThis as unknown as { chrome: Record<string, never> })
        .chrome as unknown as {
        storage: {
          local: { get(k: null): Promise<Record<string, unknown>> };
          session?: { get(k: null): Promise<Record<string, unknown>> };
        };
      };
      return {
        hasSessionArea: api.storage.session !== undefined,
        local: Object.keys(await api.storage.local.get(null)),
        session:
          api.storage.session === undefined ? [] : Object.keys(await api.storage.session.get(null)),
      };
    });

    if (!stored.hasSessionArea) throw new Error('chrome.storage.session is unavailable');
    ok('session storage is available for resumable unlocks');

    const onDisk = stored.local.find((k) => k.includes('resume'));
    if (onDisk !== undefined) {
      throw new Error(`a resumable session was written to disk: ${onDisk}`);
    }
    ok(`nothing resumable is on disk (local holds: ${stored.local.join(', ') || 'nothing'})`);

    /*
      The options page, which is a second document with no claim on the popup's keys.

      It is here rather than in a unit test because everything that can go wrong with it
      is browser-only: it constructs a KDF Worker under the MV3 CSP, mounts React from
      its own entrypoint, and reads `chrome.storage.session` from a document that did not
      write it. A test with a storage double proves none of that.

      Opened before the unlock, and left open across it. The refusal is the state a user
      meets first, and leaving the tab open is what proves the page notices an unlock
      that happens somewhere else.
    */
    const options = watch(await browser.newPage());
    await options.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'load' });
    await options.waitForSelector('[data-testid="closed-message"]', { timeout: 30_000 });
    ok('the options page loaded and asked for an unlock in the popup');

    const optionsText = await options.$eval('main', (el) => el.textContent ?? '');
    if (optionsText.includes('Not open yet')) {
      throw new Error('the options page is still the placeholder');
    }
    // The decision, asserted rather than described: the passphrase is typed in one place.
    if ((await options.$('[data-testid="passphrase"]')) !== null) {
      throw new Error('the options page is asking for a passphrase');
    }
    ok('it offers no passphrase box of its own');

    // ---- finishing enrolment, and the first real unlock ----------------------

    /**
     * Focuses the passphrase field and waits for capture to arm before typing.
     *
     * `bringToFront` first, because this run now juggles three documents and a real
     * popup is never the background tab. It also matters for the light: capture refuses
     * to run beside one it cannot see (X-1), and the failure looks identical to a field
     * that simply did not arm -- so the timeout reports what the light was actually
     * showing rather than leaving that to be guessed.
     */
    const armAndType = async (target: Page, value: string) => {
      await target.bringToFront();
      await target.focus('[data-testid="passphrase"]');
      try {
        await waitFor(
          'the light to arm',
          async () =>
            (await target.$eval(light, (el) => el.parentElement?.textContent ?? '')).includes(
              'Ready',
            ),
          15_000,
        );
      } catch {
        const state = await target.$eval(light, (el) => ({
          state: el.getAttribute('data-state'),
          label: el.parentElement?.textContent ?? '',
        }));
        throw new Error(
          `the light never armed: data-state=${state.state}, it reads "${state.label.trim()}"`,
        );
      }
      await target.keyboard.type(value, { delay: 45 });
    };

    /*
      An unenrolled account logs in and goes back to enrolment rather than to a vault.
      There is no profile, so nothing has ever been guarded here -- and until M2-00i's
      second source of the enrolment token, this path stranded the account entirely.
    */
    await armAndType(reopened, PASSPHRASE);
    await reopened.keyboard.press('Enter');
    await reopened.waitForSelector('[data-testid="step"]', { timeout: 120_000 });
    ok('unlocking resumed enrolment where the closed popup left it');

    const stepText = async () =>
      reopened.$eval('[data-testid="step"]', (el) => el.textContent ?? '');
    await reopened.focus('[data-testid="passphrase"]');
    for (let i = 0; i < 6; i += 1) {
      await waitFor('the next sample to be armed', async () =>
        (await reopened.$eval(light, (el) => el.parentElement?.textContent ?? '')).includes(
          'Ready',
        ),
      );
      const before = await stepText();
      await reopened.keyboard.type(PASSPHRASE, { delay: 45 });
      await reopened.keyboard.press('Enter');
      // Either the counter moved on or the eighth sample turned Submit into Build.
      await waitFor(
        `sample ${i + 3} to be accepted`,
        async () =>
          (await reopened.$('[data-testid="build"]')) !== null || (await stepText()) !== before,
        60_000,
      );
    }
    ok('the remaining six samples were accepted, one focus between them');

    await reopened.click('[data-testid="build"]');
    // A-4.6: the samples are deleted at this point; what survives is a set of ranges.
    await reopened.waitForSelector('[data-testid="forgot"]', { timeout: 120_000 });
    ok('the profile was built, and the popup asked for a first real unlock');

    /*
      The first login scored against a profile, which is the whole product working.

      A grey band is not a failure (X-3): it asks for a second sample and scores the
      average. Retried twice at most, because a third would be indistinguishable from a
      test that types until it gets in.
    */
    let greyRetries = 0;
    await armAndType(reopened, PASSPHRASE);
    await reopened.keyboard.press('Enter');
    await waitFor(
      'the vault to open',
      async () => {
        if ((await reopened.$('[data-testid="empty"]')) !== null) return true;
        const message = await reopened
          .$eval('[data-testid="message"]', (el) => el.textContent ?? '')
          .catch(() => '');
        if (message.includes('once more') && greyRetries < 2) {
          greyRetries += 1;
          await armAndType(reopened, PASSPHRASE);
          await reopened.keyboard.press('Enter');
        }
        return false;
      },
      180_000,
    );
    ok(
      greyRetries === 0
        ? 'the first real unlock passed the rhythm check and the vault opened'
        : `the vault opened after ${greyRetries} grey-band retype(s)`,
    );

    const unlockedStorage = await reopened.evaluate(async () => {
      const api = (globalThis as unknown as { chrome: Record<string, never> })
        .chrome as unknown as {
        storage: {
          local: { get(k: null): Promise<Record<string, unknown>> };
          session: { get(k: null): Promise<Record<string, unknown>> };
        };
      };
      return {
        local: Object.keys(await api.storage.local.get(null)),
        session: Object.keys(await api.storage.session.get(null)),
      };
    });
    if (unlockedStorage.session.find((k) => k.includes('resume')) === undefined) {
      throw new Error('an unlocked session left nothing resumable behind');
    }
    // The rule the whole product rests on: a live key never touches disk.
    const leaked = unlockedStorage.local.find((k) => k.includes('resume'));
    if (leaked !== undefined) throw new Error(`a resumable session was written to disk: ${leaked}`);
    ok('the unlocked session is resumable, in session storage and not on disk');

    // ---- the options page, on a session it did not create --------------------

    /*
      No reload. The page has been open since before the unlock, and `watchResume` is
      subscribed to the storage key the popup just wrote -- which is a cross-document
      event no unit test can produce.
    */
    await waitFor(
      'the options page to notice the unlock on its own',
      async () => (await options.$('[data-testid="strict-warning"]')) !== null,
      60_000,
    );
    ok('the open options page picked up the unlock with no reload');

    const devices = await options.$eval('[data-testid="devices"]', (el) => el.textContent ?? '');
    if (!devices.includes('This browser')) {
      throw new Error(`the device list did not come from the server: ${devices.slice(0, 120)}`);
    }
    ok('the device list came from the server over a device-signed request');

    /*
      A-17, both halves, against the real server.

      This is the part that had never run. `authHash` on the wire is a derived value and
      the server stores a password hash of it, so a screen sending the typed passphrase
      is refused every time -- which is exactly what this screen used to do, with tests
      passing.
    */
    // Foreground first. A click in a background tab hangs rather than fails: Puppeteer
    // scrolls the element into view through an IntersectionObserver, and a tab Chrome is
    // not rendering never fires one.
    await options.bringToFront();
    await options.click('[data-testid="biometric"]');
    await waitFor('the refusal to be stated', async () =>
      (await options.$eval('[data-testid="message"]', (el) => el.textContent ?? '').catch(() => ''))
        .toLowerCase()
        .includes('type your passphrase'),
    );
    ok('a weakening change with nothing typed is refused before it is sent');

    await armAndType(options, PASSPHRASE);
    // A real mouse press, which is the point: the click must not blur the field and
    // void the sample it was meant to send.
    await options.click('[data-testid="pause-3600000"]');
    await options.waitForSelector('[data-testid="unpause"]', { timeout: 120_000 });
    ok('the same change, with the passphrase typed, was accepted by the real server');

    // ---- and the popup resumes ----------------------------------------------
    await reopened.close();
    const third = watch(await browser.newPage());
    await third.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'load' });
    await third.waitForSelector('[data-testid="empty"]', { timeout: 60_000 });
    ok('reopening the popup landed in the vault, with no passphrase asked for again');

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
