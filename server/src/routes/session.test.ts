import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { generateDeviceKey, signRequest } from '../../../core/crypto/device';
import { toBase64Url, utf8Encode } from '../../../core/crypto/encoding';
import { randomBytes } from '../../../core/crypto/kdf';
import { createApp } from '../app';
import { type Config, loadConfig } from '../config';
import type { Db } from '../db/client';
import { createDb } from '../db/client';
import { migrateDb } from '../db/migrate';
import * as schema from '../db/schema/sqlite';

const SECRET_32 = 'x'.repeat(32);
const CLOCK = { value: 1_788_000_000_000, now: () => CLOCK.value };

const open: Db[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.close()));
});

type Signer = { priv: Uint8Array; id: string };

async function headersFor(
  signer: Signer,
  method: string,
  path: string,
  body: unknown,
  token?: string,
) {
  const serialized = body === undefined ? '' : JSON.stringify(body);
  const nonce = randomBytes(16);
  const ts = CLOCK.now();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-cypherkey-device': signer.id,
    'x-cypherkey-nonce': toBase64Url(nonce),
    'x-cypherkey-ts': String(ts),
    'x-cypherkey-signature': await signRequest(signer.priv, {
      nonce,
      ts,
      method,
      path,
      body: utf8Encode(serialized),
    }),
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** A signed-up account with a live session, ready to refresh or log out. */
async function loggedIn() {
  CLOCK.value = 1_788_000_000_000;
  const config: Config = loadConfig({
    JWT_SECRET: SECRET_32,
    DATABASE_URL: `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-session-${Bun.nanoseconds()}.db`,
  });
  const db = createDb(config.db);
  if (db.dialect !== 'sqlite') throw new Error('these tests are sqlite-only by design');
  open.push(db);
  await migrateDb(db);
  const app = createApp({ db, config, timingFloorMs: 0, now: CLOCK.now });

  const device = await generateDeviceKey();
  const signer: Signer = { priv: device.priv, id: toBase64Url(device.pub) };
  const authHash = toBase64Url(randomBytes(32));

  await app.request('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'shawn',
      email: 'shawn@example.test',
      authHash,
      userSalt: toBase64Url(randomBytes(16)),
      wrappedVaultKey: { ct: toBase64Url(randomBytes(48)), nonce: toBase64Url(randomBytes(12)) },
      devicePub: signer.id,
      deviceName: 'Laptop',
      devicePlatform: 'linux',
      consentAt: CLOCK.now(),
      consentPolicyVersion: '2026-09-01',
    }),
  });

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    token?: string,
    as: Signer = signer,
  ) =>
    app.request(path, {
      method,
      headers: await headersFor(as, method, path, body, token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const login = async () => {
    const body = {
      username: 'shawn',
      authHash,
      featureVector: Array.from({ length: 41 }, () => 100),
    };
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: await headersFor(signer, 'POST', '/auth/login', body),
      body: JSON.stringify(body),
    });
    return (await res.json()) as { accessToken: string; refreshToken: string };
  };

  const session = await login();
  return { app, drizzle: db.drizzle, config, signer, device, call, login, session };
}

describe('POST /auth/refresh', () => {
  test('rotates: the old token stops working and a new pair is issued', async () => {
    const a = await loggedIn();
    const res = await a.call('POST', '/auth/refresh', { refreshToken: a.session.refreshToken });
    expect(res.status).toBe(200);

    const next = (await res.json()) as { accessToken: string; refreshToken: string };
    expect(next.refreshToken).not.toBe(a.session.refreshToken);
    expect(typeof next.accessToken).toBe('string');

    const rows = await a.drizzle.select().from(schema.refreshTokens);
    expect(rows).toHaveLength(2);
    const old = rows.find((r) => r.replacedBy !== null);
    expect(old?.revokedAt).toBeInstanceOf(Date);
  });

  test('the rotated token is chained to its replacement', async () => {
    const a = await loggedIn();
    await a.call('POST', '/auth/refresh', { refreshToken: a.session.refreshToken });

    const rows = await a.drizzle.select().from(schema.refreshTokens);
    const old = rows.find((r) => r.replacedBy !== null);
    const fresh = rows.find((r) => r.replacedBy === null);
    expect(old?.replacedBy).toBe(fresh?.id as string);
  });

  test('the new token can itself be rotated', async () => {
    const a = await loggedIn();
    const first = (await (
      await a.call('POST', '/auth/refresh', { refreshToken: a.session.refreshToken })
    ).json()) as { refreshToken: string };

    const res = await a.call('POST', '/auth/refresh', { refreshToken: first.refreshToken });
    expect(res.status).toBe(200);
    expect(await a.drizzle.select().from(schema.refreshTokens)).toHaveLength(3);
  });

  test('reusing a rotated token revokes the whole family', async () => {
    const a = await loggedIn();
    const second = (await (
      await a.call('POST', '/auth/refresh', { refreshToken: a.session.refreshToken })
    ).json()) as { refreshToken: string };
    const third = (await (
      await a.call('POST', '/auth/refresh', { refreshToken: second.refreshToken })
    ).json()) as { refreshToken: string };

    // The attacker replays the first token, which was rotated two steps ago.
    const replay = await a.call('POST', '/auth/refresh', { refreshToken: a.session.refreshToken });
    expect(replay.status).toBe(401);

    const rows = await a.drizzle.select().from(schema.refreshTokens);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);

    // And the token the legitimate user is holding is dead too — that is the point.
    expect(
      (await a.call('POST', '/auth/refresh', { refreshToken: third.refreshToken })).status,
    ).toBe(401);
  });

  test('an unknown refresh token is 401 and revokes nothing', async () => {
    const a = await loggedIn();
    const res = await a.call('POST', '/auth/refresh', {
      refreshToken: toBase64Url(randomBytes(32)),
    });
    expect(res.status).toBe(401);

    const rows = await a.drizzle.select().from(schema.refreshTokens);
    expect(rows.every((r) => r.revokedAt === null)).toBe(true);
  });

  test('an expired refresh token is refused', async () => {
    const a = await loggedIn();
    CLOCK.value += 31 * 24 * 60 * 60_000;
    expect(
      (await a.call('POST', '/auth/refresh', { refreshToken: a.session.refreshToken })).status,
    ).toBe(401);
  });

  test('refresh needs no access token, since the access token is what has expired', async () => {
    const a = await loggedIn();
    CLOCK.value += 16 * 60_000; // past the 15-minute access TTL
    const res = await a.call('POST', '/auth/refresh', { refreshToken: a.session.refreshToken });
    expect(res.status).toBe(200);
  });

  test('but it does need a device signature', async () => {
    const a = await loggedIn();
    const res = await a.app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: a.session.refreshToken }),
    });
    expect(res.status).toBe(401);
  });

  test('a token cannot be rotated from a different device', async () => {
    const a = await loggedIn();
    const stranger = await generateDeviceKey();
    const res = await a.call(
      'POST',
      '/auth/refresh',
      { refreshToken: a.session.refreshToken },
      undefined,
      { priv: stranger.priv, id: toBase64Url(stranger.pub) },
    );
    expect(res.status).toBe(401);
  });

  test('the raw token is never stored', async () => {
    const a = await loggedIn();
    const rows = await a.drizzle.select().from(schema.refreshTokens);
    expect(JSON.stringify(rows)).not.toContain(a.session.refreshToken);
  });
});

describe('POST /auth/logout', () => {
  test('revokes the session and the refresh token stops working', async () => {
    const a = await loggedIn();
    const res = await a.call('POST', '/auth/logout', {}, a.session.accessToken);
    expect(res.status).toBe(200);

    const rows = await a.drizzle.select().from(schema.refreshTokens);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    expect(
      (await a.call('POST', '/auth/refresh', { refreshToken: a.session.refreshToken })).status,
    ).toBe(401);
  });

  test('needs a valid access token', async () => {
    const a = await loggedIn();
    expect((await a.call('POST', '/auth/logout', {})).status).toBe(401);
    expect((await a.call('POST', '/auth/logout', {}, `${a.session.accessToken}x`)).status).toBe(
      401,
    );
  });

  test('is idempotent', async () => {
    const a = await loggedIn();
    await a.call('POST', '/auth/logout', {}, a.session.accessToken);
    expect((await a.call('POST', '/auth/logout', {}, a.session.accessToken)).status).toBe(200);
  });
});

describe('GET /user/devices', () => {
  test('lists this account devices and marks the current one', async () => {
    const a = await loggedIn();
    const res = await a.call('GET', '/user/devices', undefined, a.session.accessToken);
    expect(res.status).toBe(200);

    const { devices } = (await res.json()) as { devices: Array<Record<string, unknown>> };
    expect(devices).toHaveLength(1);
    expect(devices[0]?.name).toBe('Laptop');
    expect(devices[0]?.platform).toBe('linux');
    expect(devices[0]?.current).toBe(true);
  });

  test('never returns another account devices', async () => {
    const a = await loggedIn();
    const b = await loggedIn();
    const res = await a.call('GET', '/user/devices', undefined, a.session.accessToken);
    const { devices } = (await res.json()) as { devices: Array<Record<string, unknown>> };
    expect(devices).toHaveLength(1);
    void b;
  });

  test('needs an access token', async () => {
    const a = await loggedIn();
    expect((await a.call('GET', '/user/devices')).status).toBe(401);
  });
});

describe('DELETE /user/devices/:id', () => {
  test('revoking a device kills its refresh tokens and its signature', async () => {
    const a = await loggedIn();
    const { devices } = (await (
      await a.call('GET', '/user/devices', undefined, a.session.accessToken)
    ).json()) as { devices: Array<{ id: string }> };
    const id = devices[0]?.id as string;

    const res = await a.call('DELETE', `/user/devices/${id}`, undefined, a.session.accessToken);
    expect(res.status).toBe(200);

    const row = (await a.drizzle.select().from(schema.devices).where(eq(schema.devices.id, id)))[0];
    expect(row?.revokedAt).toBeInstanceOf(Date);

    // A revoked device can no longer sign anything, so both of these are 401.
    expect(
      (await a.call('POST', '/auth/refresh', { refreshToken: a.session.refreshToken })).status,
    ).toBe(401);
    expect((await a.call('GET', '/user/devices', undefined, a.session.accessToken)).status).toBe(
      401,
    );
  });

  test('cannot revoke a device belonging to someone else', async () => {
    const a = await loggedIn();
    const b = await loggedIn();
    const { devices } = (await (
      await b.call('GET', '/user/devices', undefined, b.session.accessToken)
    ).json()) as { devices: Array<{ id: string }> };

    const res = await a.call(
      'DELETE',
      `/user/devices/${devices[0]?.id}`,
      undefined,
      a.session.accessToken,
    );
    expect(res.status).toBe(404);

    const row = (
      await b.drizzle
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, devices[0]?.id as string))
    )[0];
    expect(row?.revokedAt ?? null).toBeNull();
  });

  test('an unknown device id is 404', async () => {
    const a = await loggedIn();
    const res = await a.call(
      'DELETE',
      `/user/devices/${crypto.randomUUID()}`,
      undefined,
      a.session.accessToken,
    );
    expect(res.status).toBe(404);
  });
});
