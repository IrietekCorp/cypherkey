import { afterAll, describe, expect, test } from 'bun:test';
import { createApp } from '../app';
import { loadConfig } from '../config';
import { createDb } from '../db/client';
import type { Db } from '../db/client';
import { noPostgres, postgresUrl } from '../testing/postgres';

const SECRET_32 = 'x'.repeat(32);

const open: Db[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.close()));
});

describe('GET /healthz on sqlite', () => {
  const db = createDb(loadConfig({ JWT_SECRET: SECRET_32, DATABASE_URL: 'sqlite://:memory:' }).db);
  open.push(db);
  const app = createApp({ db });

  test('reports ok and the live driver name', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: 'sqlite' });
  });
});

describe.skipIf(noPostgres)('GET /healthz on postgres', () => {
  test('reports ok and the live driver name', async () => {
    const db = createDb(loadConfig({ JWT_SECRET: SECRET_32, DATABASE_URL: postgresUrl ?? '' }).db);
    open.push(db);
    const res = await createApp({ db }).request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: 'postgres' });
  });
});

describe('GET /healthz when the database is unreachable', () => {
  test('is 503 and still names the driver', async () => {
    const db: Db = {
      dialect: 'sqlite',
      drizzle: {} as Db['drizzle'],
      ping: () => Promise.reject(new Error('connection refused')),
      close: () => Promise.resolve(),
    } as Db;
    const res = await createApp({ db }).request('/healthz');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: 'sqlite' });
  });

  test('does not leak the driver error to the client', async () => {
    const db: Db = {
      dialect: 'sqlite',
      drizzle: {} as Db['drizzle'],
      ping: () => Promise.reject(new Error('password authentication failed for user "ck"')),
      close: () => Promise.resolve(),
    } as Db;
    const body = await (await createApp({ db }).request('/healthz')).text();
    expect(body).not.toContain('password');
  });
});
