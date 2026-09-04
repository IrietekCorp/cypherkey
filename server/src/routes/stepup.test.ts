import { afterAll, describe, expect, test } from 'bun:test';
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
const BASELINE = 100;
const CLOCK = { value: 1_788_000_000_000, now: () => CLOCK.value };

const at = (v: number) => Array.from({ length: VECTOR_LEN }, () => v);
const SAME = at(BASELINE); // z=0 → 1.00
const GREY = at(BASELINE + 16); // z=2 → 0.50
const FAR = at(BASELINE + 40); // z=5 → 0.14

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

async function enrolled() {
  CLOCK.value = 1_788_000_000_000;
  const config: Config = loadConfig({
    JWT_SECRET: SECRET_32,
    DATABASE_URL: `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-stepup-${Bun.nanoseconds()}.db`,
  });
  const db = createDb(config.db);
  if (db.dialect !== 'sqlite') throw new Error('these tests are sqlite-only by design');
  open.push(db);
  await migrateDb(db);
  const app = createApp({ db, config, timingFloorMs: 0, now: CLOCK.now });

  const device = await generateDeviceKey();
  const signer: Signer = { priv: device.priv, id: toBase64Url(device.pub) };
  const authHash = toBase64Url(randomBytes(32));

  const signup = await app.request('/auth/signup', {
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
  const { enrollmentToken } = (await signup.json()) as { enrollmentToken: string };

  const send = async (path: string, body: unknown, as: Signer = signer, token?: string) =>
    app.request(path, {
      method: 'POST',
      headers: await headersFor(as, 'POST', path, body, token),
      body: JSON.stringify(body),
    });

  await send('/auth/recovery-key', {
    recoveryWrappedVaultKey: {
      ct: toBase64Url(randomBytes(48)),
      nonce: toBase64Url(randomBytes(12)),
    },
  });
  for (let i = 0; i < config.enrollmentSamples; i++) {
    await send('/enroll/sample', { featureVector: SAME }, signer, enrollmentToken);
  }
  await send('/enroll/build', {}, signer, enrollmentToken);

  const login = (featureVector: number[], as: Signer = signer) =>
    send('/auth/login', { username: 'shawn', authHash, featureVector }, as);

  const stepUp = (featureVector: number[], as: Signer = signer, method = 'retype') =>
    send('/auth/step-up', { username: 'shawn', authHash, method, featureVector }, as);

  return { app, drizzle: db.drizzle, config, signer, authHash, login, stepUp, send };
}

describe('POST /auth/step-up (X-3 retype)', () => {
  test('a grey login followed by a good retype clears, and averages the two', async () => {
    const a = await enrolled();
    expect(((await (await a.login(GREY)).json()) as { band: string }).band).toBe('grey');

    const res = await a.stepUp(SAME);
    expect(res.status).toBe(200);

    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.band).toBe('pass');
    expect(payload.serverShare).toBeDefined();
    expect(payload.wrappedVaultKey).toBeDefined();
    // (0.5 grey + 1.0 retype) / 2 = 0.75
    expect(payload.score as number).toBeCloseTo(0.75, 2);
  });

  test('the issued token carries a fresh step-up flag', async () => {
    const a = await enrolled();
    await a.login(GREY);
    const { accessToken } = (await (await a.stepUp(SAME)).json()) as { accessToken: string };

    const claims = verifyToken(accessToken, SECRET_32, 'access', CLOCK.now());
    expect(claims?.stepUpAt).toBe(CLOCK.now());
  });

  test('a second bad sample does not clear it', async () => {
    const a = await enrolled();
    await a.login(GREY);

    const res = await a.stepUp(FAR);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { band: string }).band).toBe('fail');
  });

  test('the average is what decides, so grey plus grey still fails', async () => {
    const a = await enrolled();
    await a.login(GREY);
    // 0.5 and 0.5 average to 0.5, which is below the 0.62 pass band.
    expect((await a.stepUp(GREY)).status).toBe(401);
  });

  test('a stale grey attempt is not averaged in — the retype must stand alone', async () => {
    const a = await enrolled();
    await a.login(GREY);
    CLOCK.value += 6 * 60_000; // past the five-minute window

    // Alone, GREY scores 0.5 and fails; averaged with the stale 0.5 it would also fail,
    // so use a sample that only passes on its own merits.
    const res = await a.stepUp(SAME);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { score: number }).score).toBeCloseTo(1.0, 2);
  });

  test('the passphrase is still required', async () => {
    const a = await enrolled();
    await a.login(GREY);
    const res = await a.send('/auth/step-up', {
      username: 'shawn',
      authHash: toBase64Url(randomBytes(32)),
      method: 'retype',
      featureVector: SAME,
    });
    expect(res.status).toBe(401);
  });

  test('a device signature is still required', async () => {
    const a = await enrolled();
    await a.login(GREY);
    const res = await a.app.request('/auth/step-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'shawn',
        authHash: a.authHash,
        method: 'retype',
        featureVector: SAME,
      }),
    });
    expect(res.status).toBe(401);
  });

  test('an unsupported factor is refused rather than quietly accepted', async () => {
    const a = await enrolled();
    await a.login(GREY);
    for (const method of ['totp', 'passkey', 'recovery_code']) {
      const res = await a.stepUp(SAME, a.signer, method);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'unsupported_method' });
    }
  });
});

describe('a new device completing step-up (X-3)', () => {
  test('is registered only once the step-up clears', async () => {
    const a = await enrolled();
    const fresh = await generateDeviceKey();
    const stranger: Signer = { priv: fresh.priv, id: toBase64Url(fresh.pub) };

    const attempt = (await (await a.login(SAME, stranger)).json()) as { newDevice?: boolean };
    expect(attempt.newDevice).toBe(true);
    expect(await a.drizzle.select().from(schema.devices)).toHaveLength(1);

    const res = await a.stepUp(SAME, stranger);
    expect(res.status).toBe(200);

    const devices = await a.drizzle.select().from(schema.devices);
    expect(devices).toHaveLength(2);
    expect(devices.some((d) => d.publicKey === stranger.id)).toBe(true);
  });

  test('a failed step-up leaves the new device unregistered', async () => {
    const a = await enrolled();
    const fresh = await generateDeviceKey();
    const stranger: Signer = { priv: fresh.priv, id: toBase64Url(fresh.pub) };

    expect((await a.stepUp(FAR, stranger)).status).toBe(401);
    expect(await a.drizzle.select().from(schema.devices)).toHaveLength(1);
  });
});

describe('what a cleared step-up does to the profile (X-3)', () => {
  test('the sample is folded in, even inside the A-4.5 window', async () => {
    const a = await enrolled();
    const before = (await a.drizzle.select().from(schema.biometricProfiles))[0];
    expect(before?.means[0]).toBe(BASELINE);

    await a.login(GREY);
    await a.stepUp(at(BASELINE + 8));

    const after = (await a.drizzle.select().from(schema.biometricProfiles))[0];
    expect(after?.means[0]).toBeCloseTo(100.8, 5);
  });

  test('a failed step-up never touches the profile', async () => {
    const a = await enrolled();
    await a.login(GREY);
    await a.stepUp(FAR);

    const after = (await a.drizzle.select().from(schema.biometricProfiles))[0];
    expect(after?.means[0]).toBe(BASELINE);
  });
});
