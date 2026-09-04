import { afterAll, describe, expect, test } from 'bun:test';
import { toBase64Url } from '../../../core/crypto/encoding';
import { randomBytes } from '../../../core/crypto/kdf';
import { createApp } from '../app';
import { type Config, loadConfig } from '../config';
import type { Db } from '../db/client';
import { createDb } from '../db/client';
import { migrateDb } from '../db/migrate';
import * as schema from '../db/schema/sqlite';
import { clientIp, saltedId } from './identity';
import { ACCOUNT_LIMIT, IP_LIMIT } from './rate-limit';

const SECRET_32 = 'x'.repeat(32);
const CLOCK = { value: 1_788_000_000_000, now: () => CLOCK.value };

const open: Db[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.close()));
});

async function fresh() {
  CLOCK.value = 1_788_000_000_000;
  const config: Config = loadConfig({
    JWT_SECRET: SECRET_32,
    DATABASE_URL: `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-mw-${Bun.nanoseconds()}.db`,
  });
  const db = createDb(config.db);
  if (db.dialect !== 'sqlite') throw new Error('these tests are sqlite-only by design');
  open.push(db);
  await migrateDb(db);
  const app = createApp({ db, config, timingFloorMs: 0, now: CLOCK.now });

  const get = (path: string, ip = '203.0.113.9') =>
    app.request(path, { headers: { 'x-forwarded-for': ip } });

  const login = (username: string, ip = '203.0.113.9') =>
    app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({
        username,
        authHash: toBase64Url(randomBytes(32)),
        featureVector: [1],
      }),
    });

  return { app, drizzle: db.drizzle, config, get, login };
}

describe('per-IP token bucket', () => {
  test('allows the capacity, then answers 429 with Retry-After', async () => {
    const a = await fresh();
    for (let i = 0; i < IP_LIMIT.capacity; i++) {
      expect((await a.get('/healthz')).status).toBe(200);
    }
    const blocked = await a.get('/healthz');
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'rate_limited' });
    expect(blocked.headers.get('retry-after')).toBe('60');
  });

  test('one address being throttled does not throttle another', async () => {
    const a = await fresh();
    for (let i = 0; i < IP_LIMIT.capacity + 1; i++) await a.get('/healthz', '198.51.100.1');
    expect((await a.get('/healthz', '198.51.100.1')).status).toBe(429);
    expect((await a.get('/healthz', '203.0.113.7')).status).toBe(200);
  });

  test('refills continuously, so a boundary does not hand back a full burst', async () => {
    const a = await fresh();
    for (let i = 0; i < IP_LIMIT.capacity; i++) await a.get('/healthz');
    expect((await a.get('/healthz')).status).toBe(429);

    // Six seconds is a tenth of the window, so ten tokens come back — not a hundred.
    CLOCK.value += 6_000;
    for (let i = 0; i < 10; i++) {
      expect((await a.get('/healthz')).status).toBe(200);
    }
    expect((await a.get('/healthz')).status).toBe(429);
  });

  test('a full window restores the whole bucket', async () => {
    const a = await fresh();
    for (let i = 0; i < IP_LIMIT.capacity + 1; i++) await a.get('/healthz');
    expect((await a.get('/healthz')).status).toBe(429);

    CLOCK.value += IP_LIMIT.windowMs;
    expect((await a.get('/healthz')).status).toBe(200);
  });
});

describe('per-account token bucket on login', () => {
  test('ten attempts a minute, then 429 even from a fresh address', async () => {
    const a = await fresh();
    for (let i = 0; i < ACCOUNT_LIMIT.capacity; i++) {
      expect((await a.login('victim')).status).not.toBe(429);
    }
    expect((await a.login('victim')).status).toBe(429);
    // Rotating the source address does not help: the bucket is keyed by account.
    expect((await a.login('victim', '198.51.100.44')).status).toBe(429);
  });

  test('throttling one account leaves another alone', async () => {
    const a = await fresh();
    for (let i = 0; i < ACCOUNT_LIMIT.capacity + 1; i++) await a.login('victim');
    expect((await a.login('victim')).status).toBe(429);
    expect((await a.login('someone-else')).status).not.toBe(429);
  });

  test('the bucket exists whether or not the account does, so 429 is no oracle', async () => {
    const a = await fresh();
    for (let i = 0; i < ACCOUNT_LIMIT.capacity + 1; i++) await a.login('definitely-not-a-user');
    expect((await a.login('definitely-not-a-user')).status).toBe(429);

    const keys = (await a.drizzle.select().from(schema.rateLimits)).map((r) => r.key);
    expect(keys).toContain(saltedId(SECRET_32, 'ratelimit/account', 'definitely-not-a-user'));
  });

  test('the limiter runs before the route, so a throttled login is never scored', async () => {
    const a = await fresh();
    for (let i = 0; i < ACCOUNT_LIMIT.capacity + 2; i++) await a.login('victim');
    expect(await a.drizzle.select().from(schema.authScoreHistory)).toHaveLength(0);
  });
});

describe('what the rate limiter stores', () => {
  test('never an address or a username in the clear', async () => {
    const a = await fresh();
    await a.login('shawn', '203.0.113.9');

    const dump = JSON.stringify(await a.drizzle.select().from(schema.rateLimits));
    expect(dump).not.toContain('203.0.113.9');
    expect(dump).not.toContain('shawn');
  });

  test('the same value hashes differently under a different server secret', () => {
    expect(saltedId(SECRET_32, 'ip', '203.0.113.9')).not.toBe(
      saltedId('y'.repeat(40), 'ip', '203.0.113.9'),
    );
  });

  test('scopes are separated, so an IP bucket cannot collide with an account bucket', () => {
    expect(saltedId(SECRET_32, 'ratelimit/ip', 'shawn')).not.toBe(
      saltedId(SECRET_32, 'ratelimit/account', 'shawn'),
    );
  });
});

describe('clientIp', () => {
  test('takes the first entry of x-forwarded-for', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))).toBe(
      '203.0.113.9',
    );
  });

  test('falls back to a single shared bucket when the header is absent', () => {
    expect(clientIp(new Headers())).toBe('unknown');
    expect(clientIp(new Headers({ 'x-forwarded-for': '  ' }))).toBe('unknown');
  });
});

describe('audit log', () => {
  test('records auth events with a salted IP and the device that called', async () => {
    const a = await fresh();
    await a.login('shawn', '203.0.113.9');

    const rows = await a.drizzle.select().from(schema.auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe('POST /auth/login 401');
    expect(rows[0]?.ipHash).toBe(saltedId(SECRET_32, 'ip', '203.0.113.9'));
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  test('records the status, so a failure and a success are distinguishable', async () => {
    const a = await fresh();
    await a.get('/auth/salt?username=ghost');

    const rows = await a.drizzle.select().from(schema.auditLog);
    expect(rows[0]?.event).toBe('GET /auth/salt 200');
  });

  test('does not log vault traffic or health checks', async () => {
    const a = await fresh();
    await a.get('/healthz');
    await a.app.request('/vault/changes?since=0');

    expect(await a.drizzle.select().from(schema.auditLog)).toHaveLength(0);
  });

  test('stores no address, no body, no header and no score', async () => {
    const a = await fresh();
    await a.login('shawn', '203.0.113.9');

    const dump = JSON.stringify(await a.drizzle.select().from(schema.auditLog));
    expect(dump).not.toContain('203.0.113.9');
    expect(dump).not.toContain('shawn');
    expect(dump).not.toContain('authHash');
    expect(dump).not.toContain('featureVector');
    expect(dump).not.toContain('score');
  });

  test('the row holds only the columns A-9 names', async () => {
    const a = await fresh();
    await a.login('shawn');

    const row = (await a.drizzle.select().from(schema.auditLog))[0];
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'createdAt',
      'deviceId',
      'event',
      'id',
      'ipHash',
      'userId',
    ]);
  });
});
