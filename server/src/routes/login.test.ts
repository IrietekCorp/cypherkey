import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { generateDeviceKey, signRequest } from '../../../core/crypto/device';
import { toBase64Url, utf8Encode } from '../../../core/crypto/encoding';
import { randomBytes } from '../../../core/crypto/kdf';
import { createApp } from '../app';
import { verifyToken } from '../auth/token';
import { type Config, loadConfig } from '../config';
import type { Db } from '../db/client';
import { createDb } from '../db/client';
import { migrateDb } from '../db/migrate';
import * as schema from '../db/schema/sqlite';

const SECRET_32 = 'x'.repeat(32);
const SCRIPT_LEN = 12;
const VECTOR_LEN = 3 * SCRIPT_LEN + 5;
/** Every enrolment sample is this value, so means land here and stds floor at 8 ms. */
const BASELINE = 100;

/** z = |x − mean| / std, and featureScore = 1/(1+(z/2)²). std is 8 after the A-4.3 floor. */
const vectorAt = (value: number) => Array.from({ length: VECTOR_LEN }, () => value);
const SAME = vectorAt(BASELINE); //  z=0   → 1.00  → pass
const NEAR = vectorAt(BASELINE + 8); //  z=1   → 0.80  → pass, and ≥ 0.70 so it adapts
const GREY = vectorAt(BASELINE + 16); //  z=2   → 0.50  → grey
const FAR = vectorAt(BASELINE + 40); //  z=5   → 0.14  → fail

/** One mutable clock shared by the fixture and its signers, so time can be advanced. */
const CLOCK = { value: 1_788_000_000_000, now: () => CLOCK.value };

const open: Db[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.close()));
});

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

async function sigHeaders(
  priv: Uint8Array,
  deviceId: string,
  path: string,
  body: unknown,
  overrides: { ts?: number; nonce?: Uint8Array; token?: string } = {},
) {
  const nonce = overrides.nonce ?? randomBytes(16);
  const ts = overrides.ts ?? CLOCK.now();
  const headers: Record<string, string> = {
    'x-cypherkey-device': deviceId,
    'x-cypherkey-nonce': toBase64Url(nonce),
    'x-cypherkey-ts': String(ts),
    'x-cypherkey-signature': await signRequest(priv, {
      nonce,
      ts,
      method: 'POST',
      path,
      body: utf8Encode(JSON.stringify(body)),
    }),
  };
  if (overrides.token !== undefined) headers.authorization = `Bearer ${overrides.token}`;
  return headers;
}

/** A fully signed-up, enrolled account with a known profile. */
async function enrolledAccount(timingFloorMs = 0) {
  CLOCK.value = 1_788_000_000_000;
  const config: Config = loadConfig({
    JWT_SECRET: SECRET_32,
    DATABASE_URL: `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-login-${Bun.nanoseconds()}.db`,
  });
  const db = createDb(config.db);
  if (db.dialect !== 'sqlite') throw new Error('these tests are sqlite-only by design');
  open.push(db);
  await migrateDb(db);
  const app = createApp({ db, config, timingFloorMs, now: CLOCK.now });

  const device = await generateDeviceKey();
  const deviceId = toBase64Url(device.pub);
  const authHash = toBase64Url(randomBytes(32));
  const wrappedVaultKey = { ct: toBase64Url(randomBytes(48)), nonce: toBase64Url(randomBytes(12)) };

  const signup = await post(app, '/auth/signup', {
    username: 'shawn',
    email: 'shawn@example.test',
    authHash,
    userSalt: toBase64Url(randomBytes(16)),
    wrappedVaultKey,
    devicePub: deviceId,
    deviceName: 'Laptop',
    devicePlatform: 'linux',
    consentAt: 1_788_000_000_000,
    consentPolicyVersion: '2026-09-01',
  });
  const { enrollmentToken, serverShare } = (await signup.json()) as {
    enrollmentToken: string;
    serverShare: string;
  };

  const recoveryBody = {
    recoveryWrappedVaultKey: {
      ct: toBase64Url(randomBytes(48)),
      nonce: toBase64Url(randomBytes(12)),
    },
  };
  await post(
    app,
    '/auth/recovery-key',
    recoveryBody,
    await sigHeaders(device.priv, deviceId, '/auth/recovery-key', recoveryBody),
  );

  for (let i = 0; i < config.enrollmentSamples; i++) {
    const body = { featureVector: SAME };
    await post(
      app,
      '/enroll/sample',
      body,
      await sigHeaders(device.priv, deviceId, '/enroll/sample', body, { token: enrollmentToken }),
    );
  }
  await post(
    app,
    '/enroll/build',
    {},
    await sigHeaders(device.priv, deviceId, '/enroll/build', {}, { token: enrollmentToken }),
  );

  const login = async (
    featureVector: number[],
    opts: {
      authHash?: string;
      device?: { priv: Uint8Array; id: string };
      ts?: number;
      nonce?: Uint8Array;
      signed?: boolean;
    } = {},
  ) => {
    const body = {
      username: 'shawn',
      authHash: opts.authHash ?? authHash,
      featureVector,
    };
    const signer = opts.device ?? { priv: device.priv, id: deviceId };
    const headers =
      opts.signed === false
        ? {}
        : await sigHeaders(signer.priv, signer.id, '/auth/login', body, {
            ts: opts.ts,
            nonce: opts.nonce,
          });
    return post(app, '/auth/login', body, headers);
  };

  /** A-4.5 caps adaptation at once per ten minutes, so tests must be able to pass it. */
  const advance = (ms: number) => {
    CLOCK.value += ms;
  };

  return {
    app,
    drizzle: db.drizzle,
    config,
    device,
    deviceId,
    authHash,
    wrappedVaultKey,
    serverShare,
    login,
    advance,
  };
}

describe('bands (A-4.4)', () => {
  test('pass releases the tokens, the wrapped key and the server share', async () => {
    const a = await enrolledAccount();
    const res = await a.login(SAME);
    expect(res.status).toBe(200);

    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.band).toBe('pass');
    expect(payload.wrappedVaultKey).toEqual(a.wrappedVaultKey);
    expect(payload.serverShare).toBe(a.serverShare);
    expect(typeof payload.refreshToken).toBe('string');

    const claims = verifyToken(payload.accessToken as string, SECRET_32, 'access', CLOCK.now());
    expect(claims?.scope).toBe('access');
  });

  test('grey asks for a step-up and releases nothing', async () => {
    const a = await enrolledAccount();
    const res = await a.login(GREY);
    expect(res.status).toBe(200);

    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.band).toBe('grey');
    expect(Array.isArray(payload.stepUp)).toBe(true);
    expect(payload.serverShare).toBeUndefined();
    expect(payload.wrappedVaultKey).toBeUndefined();
    expect(payload.accessToken).toBeUndefined();
  });

  test('fail is 401 and releases nothing', async () => {
    const a = await enrolledAccount();
    const res = await a.login(FAR);
    expect(res.status).toBe(401);

    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.band).toBe('fail');
    expect(payload.serverShare).toBeUndefined();
  });

  test('a wrong authHash fails before the rhythm is ever scored', async () => {
    const a = await enrolledAccount();
    const res = await a.login(SAME, { authHash: toBase64Url(randomBytes(32)) });
    expect(res.status).toBe(401);

    // Nothing was scored, so no score row exists for the attempt.
    expect(await a.drizzle.select().from(schema.authScoreHistory)).toHaveLength(0);
  });

  test('an unknown username is 401 and looks like any other failure', async () => {
    const a = await enrolledAccount();
    const body = { username: 'ghost', authHash: a.authHash, featureVector: SAME };
    const res = await post(
      a.app,
      '/auth/login',
      body,
      await sigHeaders(a.device.priv, a.deviceId, '/auth/login', body),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
  });
});

describe('device binding (A-3, X-3)', () => {
  test('an unregistered device always requires a step-up, whatever the rhythm', async () => {
    const a = await enrolledAccount();
    const stranger = await generateDeviceKey();
    const res = await a.login(SAME, {
      device: { priv: stranger.priv, id: toBase64Url(stranger.pub) },
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.band).toBe('grey');
    expect(payload.newDevice).toBe(true);
    expect(payload.serverShare).toBeUndefined();
  });

  test('a request with no signature at all is refused', async () => {
    const a = await enrolledAccount();
    expect((await a.login(SAME, { signed: false })).status).toBe(401);
  });

  test('a signature from the wrong key on a registered device id is refused', async () => {
    const a = await enrolledAccount();
    const attacker = await generateDeviceKey();
    const res = await a.login(SAME, { device: { priv: attacker.priv, id: a.deviceId } });
    expect(res.status).toBe(401);
  });

  test('a replayed nonce is refused even though the signature is valid', async () => {
    const a = await enrolledAccount();
    const nonce = randomBytes(16);
    const ts = CLOCK.now();

    const first = await a.login(SAME, { nonce, ts });
    expect(first.status).toBe(200);

    const replay = await a.login(SAME, { nonce, ts });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: 'invalid_credentials' });
  });

  test('a timestamp outside the skew window is refused', async () => {
    const a = await enrolledAccount();
    expect((await a.login(SAME, { ts: CLOCK.now() - 120_000 })).status).toBe(401);
  });
});

describe('lockout (X-3: 5 fails, then exponential)', () => {
  test('five failures lock the account, and a perfect attempt then still fails', async () => {
    const a = await enrolledAccount();
    for (let i = 0; i < 5; i++) {
      expect((await a.login(FAR)).status).toBe(401);
    }

    const locked = await a.login(SAME);
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({ error: 'locked_out' });

    const row = (await a.drizzle.select().from(schema.lockouts))[0];
    expect(row?.failedCount).toBe(5);
    expect(row?.lockedUntil).toBeInstanceOf(Date);
  });

  test('a grey band does not count toward lockout', async () => {
    const a = await enrolledAccount();
    for (let i = 0; i < 6; i++) await a.login(GREY);

    const rows = await a.drizzle.select().from(schema.lockouts);
    expect(rows[0]?.failedCount ?? 0).toBe(0);
  });

  test('a pass clears the failure counter', async () => {
    const a = await enrolledAccount();
    for (let i = 0; i < 3; i++) await a.login(FAR);
    expect((await a.login(SAME)).status).toBe(200);

    const row = (await a.drizzle.select().from(schema.lockouts))[0];
    expect(row?.failedCount ?? 0).toBe(0);
    expect(row?.lockedUntil ?? null).toBeNull();
  });
});

describe('score history (A-4.6)', () => {
  test('one scalar row per scored attempt, with the band', async () => {
    const a = await enrolledAccount();
    await a.login(SAME);
    await a.login(GREY);
    await a.login(FAR);

    const rows = await a.drizzle.select().from(schema.authScoreHistory);
    expect(rows.map((r) => r.band)).toEqual(['pass', 'grey', 'fail']);
    for (const row of rows) {
      expect(typeof row.score).toBe('number');
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(1);
    }
  });

  test('the feature vector is never persisted, anywhere, after a login', async () => {
    const a = await enrolledAccount();
    await a.login(SAME);
    await a.login(GREY);
    await a.login(FAR);

    const everything = JSON.stringify({
      users: await a.drizzle.select().from(schema.users),
      devices: await a.drizzle.select().from(schema.devices),
      samples: await a.drizzle.select().from(schema.enrollmentSamples),
      scores: await a.drizzle.select().from(schema.authScoreHistory),
      nonces: await a.drizzle.select().from(schema.nonces),
      refresh: await a.drizzle.select().from(schema.refreshTokens),
      lockouts: await a.drizzle.select().from(schema.lockouts),
    });

    for (const vector of [SAME, GREY, FAR]) {
      expect(everything).not.toContain(JSON.stringify(vector));
    }
    // Not even a single dwell value should be recoverable as a stored number.
    expect(everything).not.toContain('"featureVector"');
  });

  test('the refresh token is stored hashed, never in the clear', async () => {
    const a = await enrolledAccount();
    const payload = (await (await a.login(SAME)).json()) as { refreshToken: string };

    const rows = await a.drizzle.select().from(schema.refreshTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).not.toBe(payload.refreshToken);
    expect(JSON.stringify(rows)).not.toContain(payload.refreshToken);
  });
});

describe('adaptation (A-4.5)', () => {
  test('a pass at or above 0.70 moves the profile toward the sample', async () => {
    const a = await enrolledAccount();
    const before = (await a.drizzle.select().from(schema.biometricProfiles))[0];
    expect(before?.means[0]).toBe(BASELINE);

    a.advance(11 * 60_000);
    expect((await a.login(NEAR)).status).toBe(200);

    const after = (await a.drizzle.select().from(schema.biometricProfiles))[0];
    // EMA with alpha 0.1 toward 108: 100 + 0.1 × 8 = 100.8
    expect(after?.means[0]).toBeCloseTo(100.8, 5);
  });

  test('a grey band never adapts', async () => {
    const a = await enrolledAccount();
    a.advance(11 * 60_000);
    await a.login(GREY);
    const after = (await a.drizzle.select().from(schema.biometricProfiles))[0];
    expect(after?.means[0]).toBe(BASELINE);
  });

  test('a fail never adapts', async () => {
    const a = await enrolledAccount();
    a.advance(11 * 60_000);
    await a.login(FAR);
    const after = (await a.drizzle.select().from(schema.biometricProfiles))[0];
    expect(after?.means[0]).toBe(BASELINE);
  });

  test('adaptation is capped at once per ten minutes', async () => {
    const a = await enrolledAccount();
    a.advance(11 * 60_000);
    await a.login(NEAR);
    const once = (await a.drizzle.select().from(schema.biometricProfiles))[0]?.means[0];
    expect(once).toBeCloseTo(100.8, 5);

    // Immediately again: inside the window, so the profile must not move.
    await a.login(NEAR);
    expect((await a.drizzle.select().from(schema.biometricProfiles))[0]?.means[0]).toBe(
      once as number,
    );

    // Past the window it moves again, which proves the cap is a window and not a
    // one-shot latch.
    a.advance(11 * 60_000);
    await a.login(NEAR);
    const thrice = (await a.drizzle.select().from(schema.biometricProfiles))[0]?.means[0];
    expect(thrice).toBeGreaterThan(once as number);
  });

  test('a freshly built profile does not adapt on the very next login', async () => {
    const a = await enrolledAccount();
    await a.login(NEAR);
    expect((await a.drizzle.select().from(schema.biometricProfiles))[0]?.means[0]).toBe(BASELINE);
  });
});

describe('timing (A-5: padded to the floor on all paths)', () => {
  test('pass, grey, fail and unknown-user all take at least the floor', async () => {
    const a = await enrolledAccount(120);
    const cases: Array<() => Promise<Response>> = [
      () => a.login(SAME),
      () => a.login(GREY),
      () => a.login(FAR),
      () => a.login(SAME, { authHash: toBase64Url(randomBytes(32)) }),
    ];
    for (const run of cases) {
      const started = performance.now();
      await run();
      expect(performance.now() - started).toBeGreaterThanOrEqual(115);
    }
  });
});

describe('a user who has not enrolled yet', () => {
  test('logs in on a registered device without a rhythm to score', async () => {
    const config: Config = loadConfig({
      JWT_SECRET: SECRET_32,
      DATABASE_URL: `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-login-${Bun.nanoseconds()}.db`,
    });
    const db = createDb(config.db);
    if (db.dialect !== 'sqlite') throw new Error('sqlite-only');
    open.push(db);
    await migrateDb(db);
    const app = createApp({ db, config, timingFloorMs: 0, now: CLOCK.now });

    const device = await generateDeviceKey();
    const deviceId = toBase64Url(device.pub);
    const authHash = toBase64Url(randomBytes(32));
    await post(app, '/auth/signup', {
      username: 'newbie',
      email: 'newbie@example.test',
      authHash,
      userSalt: toBase64Url(randomBytes(16)),
      wrappedVaultKey: { ct: toBase64Url(randomBytes(48)), nonce: toBase64Url(randomBytes(12)) },
      devicePub: deviceId,
      deviceName: 'Laptop',
      devicePlatform: 'linux',
      consentAt: 1_788_000_000_000,
      consentPolicyVersion: '2026-09-01',
    });

    const body = { username: 'newbie', authHash, featureVector: SAME };
    const res = await post(
      app,
      '/auth/login',
      body,
      await sigHeaders(device.priv, deviceId, '/auth/login', body),
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.band).toBe('pass');
    expect(payload.enrolled).toBe(false);
    // No profile means nothing to score, so nothing is recorded as a score.
    expect(await db.drizzle.select().from(schema.authScoreHistory)).toHaveLength(0);
  });
});
