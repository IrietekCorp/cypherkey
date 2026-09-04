import { afterAll, describe, expect, test } from 'bun:test';
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
/** 12 script tokens → 12 dwell + 11 flight + 11 digraph + 7 globals = 41 (A-4.2, `3n + 5`).
 *  12 is also the minimum the server accepts, per 03 X-2. */
const SCRIPT_LEN = 12;
const VECTOR_LEN = 3 * SCRIPT_LEN + 5;

const open: Db[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.close()));
});

/** A plausible sample: stable timings with a little jitter, so stds are non-zero. */
function sampleVector(seed: number): number[] {
  return Array.from({ length: VECTOR_LEN }, (_, i) => 90 + i * 7 + ((seed * 13 + i * 5) % 11));
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

async function authHeaders(
  priv: Uint8Array,
  deviceId: string,
  token: string | null,
  method: string,
  path: string,
  body: unknown,
) {
  const serialized = body === undefined ? '' : JSON.stringify(body);
  const nonce = randomBytes(16);
  const ts = Date.now();
  const headers: Record<string, string> = {
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
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** Signs up, registers the recovery blob, and returns everything needed to enroll. */
async function enrolledFixture(overrides: { enrollmentSamples?: string } = {}) {
  const config: Config = loadConfig({
    JWT_SECRET: SECRET_32,
    DATABASE_URL: `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-enroll-${Bun.nanoseconds()}.db`,
    ...(overrides.enrollmentSamples ? { ENROLLMENT_SAMPLES: overrides.enrollmentSamples } : {}),
  });
  const db = createDb(config.db);
  if (db.dialect !== 'sqlite') throw new Error('these tests are sqlite-only by design');
  open.push(db);
  await migrateDb(db);
  const app = createApp({ db, config, timingFloorMs: 0 });

  const device = await generateDeviceKey();
  const deviceId = toBase64Url(device.pub);
  const signupRes = await post(app, '/auth/signup', {
    username: 'shawn',
    email: 'shawn@example.test',
    authHash: toBase64Url(randomBytes(32)),
    userSalt: toBase64Url(randomBytes(16)),
    wrappedVaultKey: { ct: toBase64Url(randomBytes(48)), nonce: toBase64Url(randomBytes(12)) },
    devicePub: deviceId,
    deviceName: 'Laptop',
    devicePlatform: 'linux',
    consentAt: 1_788_000_000_000,
    consentPolicyVersion: '2026-09-01',
  });
  const { enrollmentToken } = (await signupRes.json()) as { enrollmentToken: string };

  const registerRecovery = async () => {
    const body = {
      recoveryWrappedVaultKey: {
        ct: toBase64Url(randomBytes(48)),
        nonce: toBase64Url(randomBytes(12)),
      },
    };
    return post(
      app,
      '/auth/recovery-key',
      body,
      await authHeaders(device.priv, deviceId, null, 'POST', '/auth/recovery-key', body),
    );
  };

  const sample = async (seed: number, token = enrollmentToken) => {
    const body = { featureVector: sampleVector(seed) };
    return post(
      app,
      '/enroll/sample',
      body,
      await authHeaders(device.priv, deviceId, token, 'POST', '/enroll/sample', body),
    );
  };

  const build = async (token = enrollmentToken) =>
    post(
      app,
      '/enroll/build',
      {},
      await authHeaders(device.priv, deviceId, token, 'POST', '/enroll/build', {}),
    );

  const status = async (token = enrollmentToken) =>
    app.request('/enroll/status', {
      headers: await authHeaders(device.priv, deviceId, token, 'GET', '/enroll/status', undefined),
    });

  return {
    app,
    drizzle: db.drizzle,
    config,
    device,
    deviceId,
    enrollmentToken,
    registerRecovery,
    sample,
    build,
    status,
  };
}

describe('enrollment is gated on the Recovery Kit (A-5)', () => {
  test('a sample is refused until recoveryWrappedVaultKey is registered', async () => {
    const f = await enrolledFixture();
    const res = await f.sample(0);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'recovery_key_required' });
    expect(await f.drizzle.select().from(schema.enrollmentSamples)).toHaveLength(0);
  });

  test('once registered, samples are accepted', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();
    expect((await f.sample(0)).status).toBe(200);
  });
});

describe('POST /enroll/sample', () => {
  test('counts down to zero across exactly N samples', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();

    const remaining: number[] = [];
    for (let i = 0; i < f.config.enrollmentSamples; i++) {
      const res = await f.sample(i);
      expect(res.status).toBe(200);
      remaining.push(((await res.json()) as { samplesRemaining: number }).samplesRemaining);
    }
    expect(remaining).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expect(await f.drizzle.select().from(schema.enrollmentSamples)).toHaveLength(8);
  });

  test('an extra sample beyond N is refused', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();
    for (let i = 0; i < f.config.enrollmentSamples; i++) await f.sample(i);

    const res = await f.sample(99);
    expect(res.status).toBe(409);
    expect(await f.drizzle.select().from(schema.enrollmentSamples)).toHaveLength(8);
  });

  test('rejects a vector whose length is not 3·script_len + 5', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();

    // 8 is a well-formed 3n+5 vector for a 1-token script — rejected as too short.
    for (const length of [VECTOR_LEN - 1, VECTOR_LEN + 1, 0, 8, 3 * 11 + 5]) {
      const body = { featureVector: Array.from({ length }, () => 100) };
      const res = await post(
        f.app,
        '/enroll/sample',
        body,
        await authHeaders(
          f.device.priv,
          f.deviceId,
          f.enrollmentToken,
          'POST',
          '/enroll/sample',
          body,
        ),
      );
      expect(res.status).toBe(400);
    }
    expect(await f.drizzle.select().from(schema.enrollmentSamples)).toHaveLength(0);
  });

  test('the first sample fixes the script length, and later samples must match it', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();
    await f.sample(0);

    const body = { featureVector: Array.from({ length: 3 * 13 + 5 }, () => 100) };
    const res = await post(
      f.app,
      '/enroll/sample',
      body,
      await authHeaders(
        f.device.priv,
        f.deviceId,
        f.enrollmentToken,
        'POST',
        '/enroll/sample',
        body,
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'script_length_mismatch' });
  });

  test('rejects non-finite values, which would poison the profile', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();
    for (const bad of ['NaN', null, 'abc']) {
      const vector: unknown[] = sampleVector(0);
      vector[3] = bad === 'NaN' ? Number.NaN : bad;
      const body = { featureVector: vector };
      const res = await post(
        f.app,
        '/enroll/sample',
        body,
        await authHeaders(
          f.device.priv,
          f.deviceId,
          f.enrollmentToken,
          'POST',
          '/enroll/sample',
          body,
        ),
      );
      expect(res.status).toBe(400);
    }
  });
});

describe('POST /enroll/build', () => {
  test('builds at exactly N and deletes every sample (A-4.3)', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();
    for (let i = 0; i < f.config.enrollmentSamples; i++) await f.sample(i);

    const res = await f.build();
    expect(res.status).toBe(200);

    const profiles = await f.drizzle.select().from(schema.biometricProfiles);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.scriptLen).toBe(SCRIPT_LEN);
    expect(profiles[0]?.sampleCount).toBe(8);
    expect(profiles[0]?.means).toHaveLength(VECTOR_LEN);
    expect(profiles[0]?.stds).toHaveLength(VECTOR_LEN);
    expect(profiles[0]?.weights).toHaveLength(VECTOR_LEN);

    expect(await f.drizzle.select().from(schema.enrollmentSamples)).toHaveLength(0);
  });

  test('refuses to build before N samples, and keeps what it has', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();
    for (let i = 0; i < 5; i++) await f.sample(i);

    const res = await f.build();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_enough_samples' });
    expect(await f.drizzle.select().from(schema.enrollmentSamples)).toHaveLength(5);
    expect(await f.drizzle.select().from(schema.biometricProfiles)).toHaveLength(0);
  });

  test('standard deviations are floored at 8 ms (A-4.3)', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();
    // Identical samples would otherwise give a std of exactly zero and divide by it.
    for (let i = 0; i < f.config.enrollmentSamples; i++) {
      const body = { featureVector: Array.from({ length: VECTOR_LEN }, () => 100) };
      await post(
        f.app,
        '/enroll/sample',
        body,
        await authHeaders(
          f.device.priv,
          f.deviceId,
          f.enrollmentToken,
          'POST',
          '/enroll/sample',
          body,
        ),
      );
    }
    await f.build();

    const profile = (await f.drizzle.select().from(schema.biometricProfiles))[0];
    expect(profile?.stds.every((s) => s >= 8)).toBe(true);
  });

  test('a second build is refused once a profile exists', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();
    for (let i = 0; i < f.config.enrollmentSamples; i++) await f.sample(i);
    await f.build();

    const res = await f.build();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_enrolled' });
  });

  test('samples are refused once a profile exists', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();
    for (let i = 0; i < f.config.enrollmentSamples; i++) await f.sample(i);
    await f.build();

    expect((await f.sample(0)).status).toBe(409);
  });

  test('honours ENROLLMENT_SAMPLES', async () => {
    const f = await enrolledFixture({ enrollmentSamples: '5' });
    await f.registerRecovery();
    for (let i = 0; i < 5; i++) await f.sample(i);

    expect((await f.build()).status).toBe(200);
    expect((await f.drizzle.select().from(schema.biometricProfiles))[0]?.sampleCount).toBe(5);
  });
});

describe('GET /enroll/status', () => {
  test('reports progress and then completion', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();

    let payload = (await (await f.status()).json()) as Record<string, unknown>;
    expect(payload).toEqual({ required: 8, submitted: 0, remaining: 8, built: false });

    for (let i = 0; i < 8; i++) await f.sample(i);
    payload = (await (await f.status()).json()) as Record<string, unknown>;
    expect(payload).toEqual({ required: 8, submitted: 8, remaining: 0, built: false });

    await f.build();
    payload = (await (await f.status()).json()) as Record<string, unknown>;
    expect(payload).toEqual({ required: 8, submitted: 0, remaining: 0, built: true });
  });
});

describe('authorization (A-10: token AND device signature)', () => {
  test('no token is rejected', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();
    const res = await f.sample(0, null as unknown as string);
    expect(res.status).toBe(401);
  });

  test('a forged token is rejected', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();
    expect((await f.sample(0, `${f.enrollmentToken}x`)).status).toBe(401);
  });

  test('a token minted with another secret is rejected', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();
    const { mintToken } = await import('../auth/token');
    const forged = mintToken(
      { sub: 'whoever', scope: 'enroll' },
      'y'.repeat(40),
      Date.now(),
      60_000,
    );
    expect((await f.sample(0, forged)).status).toBe(401);
  });

  test('a valid token without a device signature is rejected', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();
    const body = { featureVector: sampleVector(0) };
    const res = await post(f.app, '/enroll/sample', body, {
      authorization: `Bearer ${f.enrollmentToken}`,
    });
    expect(res.status).toBe(401);
  });

  test('a signature from another device is rejected', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();
    const attacker = await generateDeviceKey();
    const body = { featureVector: sampleVector(0) };
    const res = await post(
      f.app,
      '/enroll/sample',
      body,
      await authHeaders(
        attacker.priv,
        f.deviceId,
        f.enrollmentToken,
        'POST',
        '/enroll/sample',
        body,
      ),
    );
    expect(res.status).toBe(401);
  });
});

describe('what enrollment leaves behind', () => {
  test('after build, no feature vector survives anywhere in the database', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();
    const vectors: number[][] = [];
    for (let i = 0; i < f.config.enrollmentSamples; i++) {
      vectors.push(sampleVector(i));
      await f.sample(i);
    }
    await f.build();

    const everything = JSON.stringify({
      users: await f.drizzle.select().from(schema.users),
      devices: await f.drizzle.select().from(schema.devices),
      samples: await f.drizzle.select().from(schema.enrollmentSamples),
      profiles: await f.drizzle.select().from(schema.biometricProfiles),
      scores: await f.drizzle.select().from(schema.authScoreHistory),
    });

    for (const vector of vectors) {
      expect(everything).not.toContain(JSON.stringify(vector));
    }
    expect(await f.drizzle.select().from(schema.enrollmentSamples)).toHaveLength(0);
  });

  test('the profile keeps only aggregates, never a per-sample trace (A-4.6)', async () => {
    const f = await enrolledFixture();
    await f.registerRecovery();
    for (let i = 0; i < f.config.enrollmentSamples; i++) await f.sample(i);
    await f.build();

    const profile = (await f.drizzle.select().from(schema.biometricProfiles))[0];
    expect(Object.keys(profile ?? {}).sort()).toEqual([
      'means',
      'sampleCount',
      'scriptCommitments',
      'scriptLen',
      'stds',
      'updatedAt',
      'userId',
      'version',
      'weights',
    ]);
  });
});
