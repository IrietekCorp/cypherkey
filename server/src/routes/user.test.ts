import { afterAll, describe, expect, test } from 'bun:test';
import { extractFeatures } from '../../../core/biometrics/features';
import type { KeyEvent } from '../../../core/biometrics/types';
import { generateDeviceKey, signRequest } from '../../../core/crypto/device';
import { toBase64Url, utf8Encode } from '../../../core/crypto/encoding';
import { randomBytes } from '../../../core/crypto/kdf';
import { createApp } from '../app';
import { type Config, loadConfig } from '../config';
import type { Db } from '../db/client';
import { createDb } from '../db/client';
import { migrateDb } from '../db/migrate';
import { consistencyOf } from './user';

const SECRET_32 = 'x'.repeat(32);
const SCRIPT_LEN = 12;
const VECTOR_LEN = 3 * SCRIPT_LEN + 5;

/** A-14.2 commitments: one per script token. Distinct, deterministic, opaque. */
const commitsFor = (n = SCRIPT_LEN) =>
  Array.from({ length: n }, (_, i) => toBase64Url(new Uint8Array(16).fill(i + 1)));

const CLOCK = { value: 1_788_000_000_000, now: () => CLOCK.value };

/**
 * Samples must be physically consistent: flight is digraph − dwell, so a vector has to
 * come from real timings rather than a filled array. Scaling the whole rhythm moves
 * every feature family together, and the scores below are measured, not guessed.
 */
function rhythm(scale: number): number[] {
  const events: KeyEvent[] = [];
  const dwell = Math.round(BASELINE_DWELL * scale);
  const gap = Math.round(BASELINE_GAP * scale);
  let t = 0;
  for (let i = 0; i < SCRIPT_LEN; i++) {
    const key = String.fromCharCode(97 + i);
    events.push({ type: 'down', key, t });
    events.push({ type: 'up', key, t: t + dwell });
    t += gap;
  }
  const result = extractFeatures(events, SCRIPT_LEN);
  if ('error' in result) throw new Error(result.error);
  return result.values;
}

const BASELINE_DWELL = 80;
const BASELINE_GAP = 120;
const SAME = rhythm(1.0); // 1.00 → pass
const NEAR = rhythm(1.1); // 0.81 → pass, and >= 0.70 so it adapts
const GREY = rhythm(1.2); // 0.58 → grey
const FAR = rhythm(1.4); //  0.32 → fail

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

/** An enrolled account holding both a plain access token and a step-up-flagged one. */
async function account() {
  CLOCK.value = 1_788_000_000_000;
  const config: Config = loadConfig({
    JWT_SECRET: SECRET_32,
    DATABASE_URL: `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-user-${Bun.nanoseconds()}.db`,
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

  const call = async (method: string, path: string, body?: unknown, token?: string) =>
    app.request(path, {
      method,
      headers: await headersFor(signer, method, path, body, token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  await call('POST', '/auth/recovery-key', {
    recoveryWrappedVaultKey: {
      ct: toBase64Url(randomBytes(48)),
      nonce: toBase64Url(randomBytes(12)),
    },
    recoveryAuthHash: toBase64Url(randomBytes(32)),
  });
  for (let i = 0; i < config.enrollmentSamples; i++) {
    await call(
      'POST',
      '/enroll/sample',
      { featureVector: SAME, commitments: commitsFor() },
      enrollmentToken,
    );
  }
  await call('POST', '/enroll/build', {}, enrollmentToken);

  const plain = (await (
    await call('POST', '/auth/login', {
      username: 'shawn',
      authHash,
      featureVector: SAME,
      commitments: commitsFor(),
    })
  ).json()) as { accessToken: string };

  /** A grey login then a clean retype, which is the only way to get a step-up flag. */
  const stepUpToken = async () => {
    await call('POST', '/auth/login', {
      username: 'shawn',
      authHash,
      featureVector: GREY,
      commitments: commitsFor(),
    });
    const res = await call('POST', '/auth/step-up', {
      username: 'shawn',
      authHash,
      method: 'retype',
      featureVector: SAME,
      commitments: commitsFor(),
    });
    return ((await res.json()) as { accessToken: string }).accessToken;
  };

  return {
    app,
    drizzle: db.drizzle,
    config,
    call,
    authHash,
    plainToken: plain.accessToken,
    stepUpToken,
  };
}

describe('GET /user/settings', () => {
  test('reports the defaults for a new account', async () => {
    const a = await account();
    const res = await a.call('GET', '/user/settings', undefined, a.plainToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      biometricEnabled: true,
      pauseUntil: null,
      thresholds: { strictness: 'medium' },
      keyVersion: 1,
    });
  });

  test('needs an access token and a device signature', async () => {
    const a = await account();
    expect((await a.call('GET', '/user/settings')).status).toBe(401);
    expect((await a.app.request('/user/settings')).status).toBe(401);
  });
});

describe('PATCH /user/settings — the step-up guard (X-4)', () => {
  test('disabling the rhythm without a fresh step-up is refused', async () => {
    const a = await account();
    const res = await a.call('PATCH', '/user/settings', { biometricEnabled: false }, a.plainToken);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'step_up_required' });

    const after = (await (
      await a.call('GET', '/user/settings', undefined, a.plainToken)
    ).json()) as {
      biometricEnabled: boolean;
    };
    expect(after.biometricEnabled).toBe(true);
  });

  test('pausing without a fresh step-up is refused', async () => {
    const a = await account();
    const res = await a.call(
      'PATCH',
      '/user/settings',
      { pauseUntil: CLOCK.now() + 24 * 60 * 60_000 },
      a.plainToken,
    );
    expect(res.status).toBe(403);
  });

  test('changing Strictness without a fresh step-up is refused (A-16)', async () => {
    const a = await account();
    const res = await a.call(
      'PATCH',
      '/user/settings',
      { thresholds: { strictness: 'relaxed' } },
      a.plainToken,
    );
    expect(res.status).toBe(403);
  });

  test('with a fresh step-up, all three are allowed', async () => {
    const a = await account();
    const token = await a.stepUpToken();

    expect(
      (await a.call('PATCH', '/user/settings', { biometricEnabled: false }, token)).status,
    ).toBe(200);
    expect(
      (await a.call('PATCH', '/user/settings', { pauseUntil: CLOCK.now() + 60_000 }, token)).status,
    ).toBe(200);

    const res = await a.call(
      'PATCH',
      '/user/settings',
      { thresholds: { strictness: 'relaxed' } },
      token,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      thresholds: { strictness: 'relaxed' },
    });
  });

  test('a step-up goes stale after five minutes', async () => {
    const a = await account();
    const token = await a.stepUpToken();
    CLOCK.value += 6 * 60_000;

    const res = await a.call('PATCH', '/user/settings', { biometricEnabled: false }, token);
    expect(res.status).toBe(403);
  });

  // Turning protection back on can never need a second factor: requiring one would
  // strand a user whose factor is unavailable in the weakened state.
  test('re-enabling and un-pausing need no step-up', async () => {
    const a = await account();
    const token = await a.stepUpToken();
    await a.call('PATCH', '/user/settings', { biometricEnabled: false }, token);
    CLOCK.value += 6 * 60_000;

    expect(
      (await a.call('PATCH', '/user/settings', { biometricEnabled: true }, a.plainToken)).status,
    ).toBe(200);
    expect(
      (await a.call('PATCH', '/user/settings', { pauseUntil: null }, a.plainToken)).status,
    ).toBe(200);
  });
});

describe('PATCH /user/settings — validation', () => {
  test('Strict is refused here, because it is a re-key and not an edit (A-16)', async () => {
    const a = await account();
    const token = await a.stepUpToken();
    const res = await a.call(
      'PATCH',
      '/user/settings',
      { thresholds: { strictness: 'strict' } },
      token,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'strict_requires_rekey' });
  });

  test('an absurd pause is refused', async () => {
    const a = await account();
    const token = await a.stepUpToken();
    const res = await a.call(
      'PATCH',
      '/user/settings',
      { pauseUntil: CLOCK.now() + 365 * 24 * 60 * 60_000 },
      token,
    );
    expect(res.status).toBe(400);
  });

  test('an empty or malformed patch is refused', async () => {
    const a = await account();
    const token = await a.stepUpToken();
    for (const body of [
      {},
      { biometricEnabled: 'no' },
      { thresholds: { strictness: 'paranoid' } },
    ]) {
      expect((await a.call('PATCH', '/user/settings', body, token)).status).toBe(400);
    }
  });

  test('a pause actually takes effect on the next login (X-4)', async () => {
    const a = await account();
    const token = await a.stepUpToken();

    // Before the pause, this sample fails the rhythm.
    const before = await a.call('POST', '/auth/login', {
      username: 'shawn',
      authHash: a.authHash,
      featureVector: FAR,
      commitments: commitsFor(),
    });
    expect(before.status).toBe(401);

    await a.call('PATCH', '/user/settings', { pauseUntil: CLOCK.now() + 60 * 60_000 }, token);

    // After it, the same sample is let through, because scoring is skipped entirely.
    const after = await a.call('POST', '/auth/login', {
      username: 'shawn',
      authHash: a.authHash,
      featureVector: FAR,
      commitments: commitsFor(),
    });
    expect(after.status).toBe(200);
    expect(((await after.json()) as { band: string }).band).toBe('pass');
  });

  test('a pause weakens the rhythm, never the passphrase', async () => {
    const a = await account();
    const token = await a.stepUpToken();
    await a.call('PATCH', '/user/settings', { pauseUntil: CLOCK.now() + 60 * 60_000 }, token);

    const res = await a.call('POST', '/auth/login', {
      username: 'shawn',
      authHash: toBase64Url(randomBytes(32)),
      featureVector: SAME,
      commitments: commitsFor(),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /user/rhythm', () => {
  test('reports the sample count and recent scalar scores', async () => {
    const a = await account();
    const res = await a.call('GET', '/user/rhythm', undefined, a.plainToken);
    expect(res.status).toBe(200);

    const payload = (await res.json()) as {
      sampleCount: number;
      recentScores: number[];
      consistency: number | null;
    };
    expect(payload.sampleCount).toBe(a.config.enrollmentSamples);
    expect(payload.recentScores.length).toBeGreaterThan(0);
    for (const s of payload.recentScores) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  test('returns scalars only — nothing that could be inverted into timings', async () => {
    const a = await account();
    const body = await (await a.call('GET', '/user/rhythm', undefined, a.plainToken)).text();

    expect(body).not.toContain('featureVector');
    expect(body).not.toContain('means');
    expect(body).not.toContain('stds');
    expect(body).not.toContain(JSON.stringify(SAME));
    expect(Object.keys(JSON.parse(body)).sort()).toEqual([
      'consistency',
      'recentScores',
      'sampleCount',
    ]);
  });

  test('needs an access token', async () => {
    const a = await account();
    expect((await a.call('GET', '/user/rhythm')).status).toBe(401);
  });
});

describe('consistency (X-7)', () => {
  test('is null below two scores, since one score has no spread', () => {
    expect(consistencyOf([])).toBeNull();
    expect(consistencyOf([0.9])).toBeNull();
  });

  test('identical scores are perfectly consistent', () => {
    // Floating point leaves a ~1e-16 residue in the variance, so this is not exact.
    expect(consistencyOf([0.7, 0.7, 0.7]) as number).toBeCloseTo(1, 10);
  });

  test('measures steadiness, not skill — a steady 0.7 beats an erratic 0.9', () => {
    const steady = consistencyOf([0.7, 0.7, 0.71, 0.69]) as number;
    const erratic = consistencyOf([0.9, 0.4, 0.95, 0.35]) as number;
    expect(steady).toBeGreaterThan(erratic);
  });

  test('stays within 0 and 1', () => {
    expect(consistencyOf([0, 1, 0, 1]) as number).toBeGreaterThanOrEqual(0);
    expect(consistencyOf([0, 1, 0, 1]) as number).toBeLessThanOrEqual(1);
  });
});
