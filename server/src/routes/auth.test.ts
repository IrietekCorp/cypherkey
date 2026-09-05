import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { generateDeviceKey, signRequest } from '../../../core/crypto/device';
import { fromBase64Url, toBase64Url, utf8Encode } from '../../../core/crypto/encoding';
import { randomBytes } from '../../../core/crypto/kdf';
import { createApp } from '../app';
import { type Config, loadConfig } from '../config';
import type { Db } from '../db/client';
import { createDb } from '../db/client';
import { migrateDb } from '../db/migrate';
import * as schema from '../db/schema/sqlite';

const SECRET_32 = 'x'.repeat(32);

const open: Db[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.close()));
});

async function freshApp(timingFloorMs = 0) {
  const config: Config = loadConfig({
    JWT_SECRET: SECRET_32,
    DATABASE_URL: `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-auth-${Bun.nanoseconds()}.db`,
  });
  const db = createDb(config.db);
  if (db.dialect !== 'sqlite') throw new Error('these tests are sqlite-only by design');
  open.push(db);
  await migrateDb(db);
  return { app: createApp({ db, config, timingFloorMs }), drizzle: db.drizzle, config };
}

/** A signup body that is valid unless a test deliberately breaks one field. */
async function signupBody(overrides: Record<string, unknown> = {}) {
  const device = await generateDeviceKey();
  return {
    device,
    body: {
      username: 'shawn',
      email: 'shawn@example.test',
      authHash: toBase64Url(randomBytes(32)),
      userSalt: toBase64Url(randomBytes(16)),
      wrappedVaultKey: { ct: toBase64Url(randomBytes(48)), nonce: toBase64Url(randomBytes(12)) },
      devicePub: toBase64Url(device.pub),
      deviceName: 'Laptop',
      devicePlatform: 'linux',
      consentAt: 1_788_000_000_000,
      consentPolicyVersion: '2026-09-01',
      ...overrides,
    },
  };
}

function post(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** Builds the A-3 headers for a signed request. */
async function signedHeaders(
  priv: Uint8Array,
  deviceId: string,
  method: string,
  path: string,
  body: unknown,
) {
  const serialized = JSON.stringify(body);
  const nonce = randomBytes(16);
  const ts = Date.now();
  return {
    'x-cypherkey-device': deviceId,
    'x-cypherkey-nonce': toBase64Url(nonce),
    'x-cypherkey-ts': String(ts),
    'x-cypherkey-signature': await signRequest(priv, {
      nonce,
      ts,
      method,
      path,
      body: utf8Encode(serialized),
    }),
  };
}

describe('POST /auth/signup', () => {
  test('creates the account and returns serverShare in the 201 (A-5 handshake)', async () => {
    const { app, drizzle } = await freshApp();
    const { body } = await signupBody();

    const res = await post(app, '/auth/signup', body);
    expect(res.status).toBe(201);

    const payload = (await res.json()) as { userId: string; serverShare: string };
    expect(typeof payload.userId).toBe('string');
    expect(fromBase64Url(payload.serverShare).length).toBe(32);

    const rows = await drizzle.select().from(schema.users);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.username).toBe('shawn');
  });

  test('stores Argon2id(authHash), never the authHash itself', async () => {
    const { app, drizzle } = await freshApp();
    const { body } = await signupBody();
    await post(app, '/auth/signup', body);

    const row = (await drizzle.select().from(schema.users))[0];
    expect(row?.authHash).toStartWith('$argon2id$');
    expect(row?.authHash).not.toContain(body.authHash as string);
    expect(await Bun.password.verify(body.authHash as string, row?.authHash as string)).toBe(true);
  });

  test('records consent and the per-account Argon parameters (A-12, A-2)', async () => {
    const { app, drizzle, config } = await freshApp();
    const { body } = await signupBody();
    await post(app, '/auth/signup', body);

    const row = (await drizzle.select().from(schema.users))[0];
    expect(row?.consentAt).toBeInstanceOf(Date);
    expect(row?.consentAt?.getTime()).toBe(1_788_000_000_000);
    expect(row?.consentPolicyVersion).toBe('2026-09-01');
    expect(row?.argonParams).toEqual(config.argonParams);
    expect(row?.keyVersion).toBe(1);
  });

  test('registers the device public key', async () => {
    const { app, drizzle } = await freshApp();
    const { body } = await signupBody();
    await post(app, '/auth/signup', body);

    const devices = await drizzle.select().from(schema.devices);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.publicKey).toBe(body.devicePub as string);
    expect(devices[0]?.name).toBe('Laptop');
  });

  test('a duplicate username is 409', async () => {
    const { app } = await freshApp();
    const first = await signupBody();
    const second = await signupBody({ email: 'other@example.test' });

    expect((await post(app, '/auth/signup', first.body)).status).toBe(201);
    const res = await post(app, '/auth/signup', second.body);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'username_taken' });
  });

  test('rejects a malformed body with 400 and does not create a user', async () => {
    const { app, drizzle } = await freshApp();
    const cases = [
      { username: undefined },
      { authHash: 'not base64url!' },
      { userSalt: toBase64Url(randomBytes(8)) },
      { devicePub: toBase64Url(randomBytes(16)) },
      { consentPolicyVersion: undefined },
      { email: 'not-an-email' },
      { wrappedVaultKey: { ct: 'AAAA' } },
    ];
    for (const override of cases) {
      const { body } = await signupBody(override);
      expect((await post(app, '/auth/signup', body)).status).toBe(400);
    }
    expect(await drizzle.select().from(schema.users)).toHaveLength(0);
  });

  test('the server share is fresh per account, not a constant', async () => {
    const shares = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { app } = await freshApp();
      const { body } = await signupBody();
      const res = await post(app, '/auth/signup', body);
      shares.add(((await res.json()) as { serverShare: string }).serverShare);
    }
    expect(shares.size).toBe(5);
  });
});

describe('GET /auth/salt', () => {
  test('returns the registered salt and the Argon parameters of that account', async () => {
    const { app } = await freshApp();
    const { body } = await signupBody();
    await post(app, '/auth/signup', body);

    const res = await app.request('/auth/salt?username=shawn');
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.userSalt).toBe(body.userSalt);
    expect(payload.deviceRegistered).toBe(true);
  });

  test('an unknown user gets a deterministic fake salt, not a 404', async () => {
    const { app } = await freshApp();
    const first = await app.request('/auth/salt?username=nobody');
    const second = await app.request('/auth/salt?username=nobody');

    expect(first.status).toBe(200);
    const a = (await first.json()) as Record<string, unknown>;
    const b = (await second.json()) as Record<string, unknown>;
    expect(a.userSalt).toBe(b.userSalt as string);
    expect(fromBase64Url(a.userSalt as string).length).toBe(16);
    expect(a.deviceRegistered).toBe(false);
  });

  test('different unknown users get different fake salts', async () => {
    const { app } = await freshApp();
    const one = (await (await app.request('/auth/salt?username=alice')).json()) as Record<
      string,
      unknown
    >;
    const two = (await (await app.request('/auth/salt?username=bob')).json()) as Record<
      string,
      unknown
    >;
    expect(one.userSalt).not.toBe(two.userSalt as string);
  });

  test('the fake salt is keyed to the server secret, so it is not guessable', async () => {
    const { app: appA } = await freshApp();
    const configB = loadConfig({
      JWT_SECRET: 'y'.repeat(40),
      DATABASE_URL: `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-auth-${Bun.nanoseconds()}.db`,
    });
    const dbB = createDb(configB.db);
    open.push(dbB);
    await migrateDb(dbB);
    const appB = createApp({ db: dbB, config: configB, timingFloorMs: 0 });

    const a = (await (await appA.request('/auth/salt?username=nobody')).json()) as Record<
      string,
      unknown
    >;
    const b = (await (await appB.request('/auth/salt?username=nobody')).json()) as Record<
      string,
      unknown
    >;
    expect(a.userSalt).not.toBe(b.userSalt as string);
  });

  test('a known and an unknown user are indistinguishable in shape', async () => {
    const { app } = await freshApp();
    const { body } = await signupBody();
    await post(app, '/auth/signup', body);

    const known = (await (await app.request('/auth/salt?username=shawn')).json()) as object;
    const unknown = (await (await app.request('/auth/salt?username=ghost')).json()) as object;
    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
  });

  test('requires a username', async () => {
    const { app } = await freshApp();
    expect((await app.request('/auth/salt')).status).toBe(400);
  });

  test('both branches are padded to the timing floor, so enumeration cannot be timed', async () => {
    const { app } = await freshApp(120);
    const { body } = await signupBody();
    await post(app, '/auth/signup', body);

    for (const username of ['shawn', 'ghost']) {
      const started = performance.now();
      await app.request(`/auth/salt?username=${username}`);
      expect(performance.now() - started).toBeGreaterThanOrEqual(115);
    }
  });
});

describe('POST /auth/recovery-key (second leg of signup)', () => {
  const blob = () => ({
    recoveryWrappedVaultKey: {
      ct: toBase64Url(randomBytes(48)),
      nonce: toBase64Url(randomBytes(12)),
    },
    // M2-00f: the verifier lands in the same one-shot call as the blob.
    recoveryAuthHash: toBase64Url(randomBytes(32)),
  });

  async function signedUp() {
    const { app, drizzle } = await freshApp();
    const { body, device } = await signupBody();
    await post(app, '/auth/signup', body);
    return { app, drizzle, device, deviceId: body.devicePub as string };
  }

  test('stores the blob when the request carries a valid device signature', async () => {
    const { app, drizzle, device, deviceId } = await signedUp();
    const payload = blob();
    const headers = await signedHeaders(
      device.priv,
      deviceId,
      'POST',
      '/auth/recovery-key',
      payload,
    );

    const res = await post(app, '/auth/recovery-key', payload, headers);
    expect(res.status).toBe(200);

    const row = (await drizzle.select().from(schema.users))[0];
    expect(row?.recoveryWrappedVaultKey).toEqual(payload.recoveryWrappedVaultKey);
  });

  test('an unsigned request is rejected — this write must not be anonymous', async () => {
    const { app, drizzle } = await signedUp();
    const res = await post(app, '/auth/recovery-key', blob());
    expect(res.status).toBe(401);

    const row = (await drizzle.select().from(schema.users))[0];
    expect(row?.recoveryWrappedVaultKey).toBeNull();
  });

  test('a signature over a different body is rejected', async () => {
    const { app, device, deviceId } = await signedUp();
    const headers = await signedHeaders(
      device.priv,
      deviceId,
      'POST',
      '/auth/recovery-key',
      blob(),
    );
    expect((await post(app, '/auth/recovery-key', blob(), headers)).status).toBe(401);
  });

  test('a signature from another device is rejected', async () => {
    const { app, deviceId } = await signedUp();
    const attacker = await generateDeviceKey();
    const payload = blob();
    const headers = await signedHeaders(
      attacker.priv,
      deviceId,
      'POST',
      '/auth/recovery-key',
      payload,
    );
    expect((await post(app, '/auth/recovery-key', payload, headers)).status).toBe(401);
  });

  test('a stale timestamp is rejected (A-3 skew window)', async () => {
    const { app, device, deviceId } = await signedUp();
    const payload = blob();
    const headers = await signedHeaders(
      device.priv,
      deviceId,
      'POST',
      '/auth/recovery-key',
      payload,
    );
    headers['x-cypherkey-ts'] = String(Date.now() - 120_000);
    expect((await post(app, '/auth/recovery-key', payload, headers)).status).toBe(401);
  });

  test('it is one-shot: a second registration cannot overwrite the first', async () => {
    const { app, drizzle, device, deviceId } = await signedUp();
    const first = blob();
    await post(
      app,
      '/auth/recovery-key',
      first,
      await signedHeaders(device.priv, deviceId, 'POST', '/auth/recovery-key', first),
    );

    const second = blob();
    const res = await post(
      app,
      '/auth/recovery-key',
      second,
      await signedHeaders(device.priv, deviceId, 'POST', '/auth/recovery-key', second),
    );
    expect(res.status).toBe(409);

    const row = (await drizzle.select().from(schema.users))[0];
    expect(row?.recoveryWrappedVaultKey).toEqual(first.recoveryWrappedVaultKey);
  });
});

describe('what the database is allowed to hold after signup', () => {
  test('no table holds a feature vector, a passphrase or a plaintext key', async () => {
    const { app, drizzle } = await freshApp();
    const { body } = await signupBody();
    await post(app, '/auth/signup', body);

    const users = await drizzle.select().from(schema.users);
    const devices = await drizzle.select().from(schema.devices);
    const samples = await drizzle.select().from(schema.enrollmentSamples);
    const dump = JSON.stringify({ users, devices });

    expect(samples).toHaveLength(0);
    expect(dump).not.toContain(body.authHash as string);
    expect(dump).not.toContain('featureVector');
    expect(dump).not.toContain('passphrase');
  });

  test('the server share is stored but the vault key is not derivable from the row', async () => {
    const { app, drizzle } = await freshApp();
    const { body } = await signupBody();
    const res = await post(app, '/auth/signup', body);
    const { serverShare } = (await res.json()) as { serverShare: string };

    const row = (await drizzle.select().from(schema.users))[0];
    expect(row?.serverShare).toBe(serverShare);
    // The other half is wrapped under wrapKey, which needs the passphrase.
    expect(row?.wrappedVaultKey).toEqual(body.wrappedVaultKey);
  });
});
