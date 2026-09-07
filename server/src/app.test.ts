import { describe, expect, test } from 'bun:test';
import { createApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { migrateDb } from './db/migrate';

const CONFIG = loadConfig({
  JWT_SECRET: 'x'.repeat(32),
  DATABASE_URL: 'sqlite://:memory:',
});

async function app() {
  const db = createDb(CONFIG.db);
  await migrateDb(db);
  return createApp({ db, config: CONFIG, timingFloorMs: 0 });
}

/**
 * The deployed API once answered `/healthz` with 200 and every other route with 404.
 *
 * `config` was optional on `AppDeps`, every route but health was mounted behind
 * `if (deps.config !== undefined)`, and the production entrypoint called
 * `createApp({ db })`. Nothing failed: the container started, both probes passed, the
 * deploy went green, and the smoke test -- which checked `/healthz` -- agreed. The
 * first real client got `404 Not Found` from `/auth/salt`, whose body parses as the
 * number 404 followed by junk, so the error surfaced as a JSON syntax error.
 *
 * `config` is required now, so that particular mistake will not compile. These assert
 * the property that actually matters: a built app serves more than its health check.
 */
describe('the app serves the API, not just its health check', () => {
  test('/healthz answers', async () => {
    const res = await (await app()).request('/healthz');
    expect(res.status).toBe(200);
  });

  test('a route from every mounted group exists', async () => {
    const built = await app();
    // Not asserting on status: unauthenticated and malformed requests legitimately
    // return 400/401/404-for-a-missing-record. What must never happen is Hono's own
    // "no such route" 404, which is what an unmounted group produces.
    // The verb matters: Hono answers a method mismatch with the same "404 Not Found"
    // as an unmounted route, so a GET against a POST-only path would look identical to
    // the bug this is guarding.
    const routes: Array<[string, string]> = [
      ['GET', '/auth/salt?username=nobody'],
      ['POST', '/auth/signup'],
      ['POST', '/auth/login'],
      ['GET', '/enroll/status'],
      ['GET', '/vault/changes'],
      ['GET', '/user/settings'],
      ['POST', '/auth/refresh'],
    ];
    for (const [method, path] of routes) {
      const res = await built.request(path, {
        method,
        ...(method === 'POST'
          ? { headers: { 'content-type': 'application/json' }, body: '{}' }
          : {}),
      });
      const body = await res.text();
      expect({ path, body }).not.toEqual({ path, body: '404 Not Found' });
    }
  });

  test('an unmounted path still 404s, so the check above means something', async () => {
    const res = await (await app()).request('/definitely-not-a-route');
    expect(await res.text()).toBe('404 Not Found');
  });
});
