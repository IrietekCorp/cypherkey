import { afterAll, describe, expect, test } from 'bun:test';
import { extractFeatures } from '../../../core/biometrics/features';
import { eventsToScript } from '../../../core/biometrics/script';
import type { KeyEvent } from '../../../core/biometrics/types';
import { wrapKey } from '../../../core/crypto/aead';
import { generateDeviceKey, signRequest } from '../../../core/crypto/device';
import { toBase64Url, utf8Encode } from '../../../core/crypto/encoding';
import { deriveMasterKey, deriveSubkey, randomBytes } from '../../../core/crypto/kdf';
import { type Strictness, kdfInput, scriptCommitments } from '../../../core/crypto/phantom';
import { createApp } from '../app';
import { type Config, loadConfig } from '../config';
import type { Db } from '../db/client';
import { createDb } from '../db/client';
import { migrateDb } from '../db/migrate';
import * as schema from '../db/schema/sqlite';

const SECRET_32 = 'x'.repeat(32);
const CLOCK = { value: 1_788_000_000_000, now: () => CLOCK.value };
const FAST = { m: 256, t: 1, p: 1 } as const;

/** Two Phantom Keys: a doubled `s` corrected away, and a lone Escape. */
const KEYS = ['p', 'a', 's', 's', 's', 'Backspace', 'Escape', 'w', '0', 'r', 'd', '!'];

const open: Db[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.close()));
});

type Signer = { priv: Uint8Array; id: string };

function typeKeys(dwell = 80, gap = 120): KeyEvent[] {
  const events: KeyEvent[] = [];
  let t = 0;
  for (const key of KEYS) {
    events.push({ type: 'down', key, t });
    events.push({ type: 'up', key, t: t + dwell });
    t += gap;
  }
  return events;
}

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

/** The full A-2 branch set for a given Strictness, plus the derived login material. */
async function material(level: Strictness, salt: Uint8Array, dwell = 80, gap = 120) {
  const events = typeKeys(dwell, gap);
  const script = eventsToScript(events);
  if ('error' in script) throw new Error(script.error);
  const features = extractFeatures(events, KEYS.length);
  if ('error' in features) throw new Error(features.error);

  const master = await deriveMasterKey(kdfInput(script.resolved, script.script, level), salt, FAST);
  const authKey = await deriveSubkey(master, 'cypherkey/auth/v1');
  const wrapKeyBytes = await deriveSubkey(master, 'cypherkey/wrap/v1');
  const phantomKey = await deriveSubkey(master, 'cypherkey/phantom/v1');
  master.fill(0);

  return {
    script: script.script,
    authHash: toBase64Url(authKey),
    wrapKeyBytes,
    featureVector: features.values,
    commitments: (await scriptCommitments(phantomKey, script.script)).map(toBase64Url),
  };
}

/** An enrolled account on Medium, holding a step-up-flagged token. */
async function enrolledOnMedium() {
  CLOCK.value = 1_788_000_000_000;
  const config: Config = loadConfig({
    JWT_SECRET: SECRET_32,
    DATABASE_URL: `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-rekey-${Bun.nanoseconds()}.db`,
  });
  const db = createDb(config.db);
  if (db.dialect !== 'sqlite') throw new Error('these tests are sqlite-only by design');
  open.push(db);
  await migrateDb(db);
  const app = createApp({ db, config, timingFloorMs: 0, now: CLOCK.now });

  const device = await generateDeviceKey();
  const signer: Signer = { priv: device.priv, id: toBase64Url(device.pub) };
  const userSalt = randomBytes(16);
  const medium = await material('medium', userSalt);
  const vaultShare = randomBytes(32);

  const call = async (method: string, path: string, body?: unknown, token?: string) =>
    app.request(path, {
      method,
      headers: await headersFor(signer, method, path, body, token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const wrapped = await wrapKey(vaultShare, medium.wrapKeyBytes, 'cypherkey/wrap/vault-key/v1');
  const signup = await app.request('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'shawn',
      email: 'shawn@example.test',
      authHash: medium.authHash,
      userSalt: toBase64Url(userSalt),
      wrappedVaultKey: { ct: toBase64Url(wrapped.ct), nonce: toBase64Url(wrapped.nonce) },
      devicePub: signer.id,
      deviceName: 'Laptop',
      devicePlatform: 'linux',
      consentAt: CLOCK.now(),
      consentPolicyVersion: '2026-09-01',
    }),
  });
  const { enrollmentToken } = (await signup.json()) as { enrollmentToken: string };

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
      { featureVector: medium.featureVector, commitments: medium.commitments },
      enrollmentToken,
    );
  }
  await call('POST', '/enroll/build', {}, enrollmentToken);

  const login = (m: { authHash: string; featureVector: number[]; commitments: string[] }) =>
    call('POST', '/auth/login', {
      username: 'shawn',
      authHash: m.authHash,
      featureVector: m.featureVector,
      commitments: m.commitments,
    });

  /** A grey login then a clean retype, the only route to a step-up-flagged token. */
  const stepUpToken = async () => {
    const grey = await material('medium', userSalt, 96, 144);
    await login(grey);
    const res = await call('POST', '/auth/step-up', {
      username: 'shawn',
      authHash: medium.authHash,
      method: 'retype',
      featureVector: medium.featureVector,
      commitments: medium.commitments,
    });
    return ((await res.json()) as { accessToken: string }).accessToken;
  };

  return {
    app,
    drizzle: db.drizzle,
    config,
    call,
    login,
    userSalt,
    medium,
    vaultShare,
    stepUpToken,
  };
}

describe('medium → relaxed', () => {
  test('is a settings edit: no key moves', async () => {
    const a = await enrolledOnMedium();
    const before = (await a.drizzle.select().from(schema.users))[0];
    const token = await a.stepUpToken();

    const res = await a.call(
      'PATCH',
      '/user/settings',
      { thresholds: { strictness: 'relaxed' } },
      token,
    );
    expect(res.status).toBe(200);

    const after = (await a.drizzle.select().from(schema.users))[0];
    expect(after?.authHash).toBe(before?.authHash as string);
    expect(after?.wrappedVaultKey).toEqual(before?.wrappedVaultKey);
    expect(after?.keyVersion).toBe(before?.keyVersion as number);
    expect(after?.thresholdsJson?.strictness).toBe('relaxed');
  });

  test('the original passphrase still logs in afterwards', async () => {
    const a = await enrolledOnMedium();
    const token = await a.stepUpToken();
    await a.call('PATCH', '/user/settings', { thresholds: { strictness: 'relaxed' } }, token);

    const res = await a.login(a.medium);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { band: string }).band).toBe('pass');
  });
});

describe('medium → strict', () => {
  /** What the client computes for the new Strictness and posts to /user/rekey. */
  async function rekeyBody(a: Awaited<ReturnType<typeof enrolledOnMedium>>) {
    const strict = await material('strict', a.userSalt);
    const rewrapped = await wrapKey(
      a.vaultShare,
      strict.wrapKeyBytes,
      'cypherkey/wrap/vault-key/v1',
    );
    return {
      strict,
      body: {
        strictness: 'strict' as const,
        authHash: strict.authHash,
        wrappedVaultKey: { ct: toBase64Url(rewrapped.ct), nonce: toBase64Url(rewrapped.nonce) },
        commitments: strict.commitments,
      },
    };
  }

  test('rotates the key material and bumps key_version', async () => {
    const a = await enrolledOnMedium();
    const before = (await a.drizzle.select().from(schema.users))[0];
    const token = await a.stepUpToken();
    const { body } = await rekeyBody(a);

    const res = await a.call('POST', '/user/rekey', body, token);
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      keyVersion: (before?.keyVersion as number) + 1,
      strictness: 'strict',
    });

    const after = (await a.drizzle.select().from(schema.users))[0];
    expect(after?.authHash).not.toBe(before?.authHash as string);
    expect(after?.wrappedVaultKey).not.toEqual(before?.wrappedVaultKey);
    expect(after?.keyVersion).toBe((before?.keyVersion as number) + 1);
  });

  test('the old authHash no longer works, and the new one does', async () => {
    const a = await enrolledOnMedium();
    const token = await a.stepUpToken();
    const { strict, body } = await rekeyBody(a);
    expect((await a.call('POST', '/user/rekey', body, token)).status).toBe(200);

    // Same passphrase, same script — but Medium's kdfInput no longer derives the key.
    const old = await a.login(a.medium);
    expect(old.status).toBe(401);
    expect(((await old.json()) as { error: string }).error).toBe('invalid_credentials');

    const fresh = await a.login(strict);
    expect(fresh.status).toBe(200);
    expect(((await fresh.json()) as { band: string }).band).toBe('pass');
  });

  test('the commitments are replaced, so the old ones no longer align', async () => {
    const a = await enrolledOnMedium();
    const token = await a.stepUpToken();
    const { strict, body } = await rekeyBody(a);
    await a.call('POST', '/user/rekey', body, token);

    const profile = (await a.drizzle.select().from(schema.biometricProfiles))[0];
    expect(profile?.scriptCommitments).toEqual(strict.commitments);
    expect(profile?.scriptCommitments).not.toEqual(a.medium.commitments);
    // Same script, different phantomKey, so every commitment changed.
    expect(strict.commitments).toHaveLength(a.medium.commitments.length);
  });

  test('the vault key never moves, so the Recovery Kit blob is untouched', async () => {
    const a = await enrolledOnMedium();
    const before = (await a.drizzle.select().from(schema.users))[0];
    const token = await a.stepUpToken();
    const { body } = await rekeyBody(a);
    await a.call('POST', '/user/rekey', body, token);

    const after = (await a.drizzle.select().from(schema.users))[0];
    expect(after?.recoveryWrappedVaultKey).toEqual(before?.recoveryWrappedVaultKey);
    expect(after?.serverShare).toBe(before?.serverShare as string);
  });
});

describe('what /user/rekey refuses', () => {
  test('a token without a fresh step-up', async () => {
    const a = await enrolledOnMedium();
    const plain = (await (await a.login(a.medium)).json()) as { accessToken: string };
    const strict = await material('strict', a.userSalt);
    const rewrapped = await wrapKey(
      a.vaultShare,
      strict.wrapKeyBytes,
      'cypherkey/wrap/vault-key/v1',
    );

    const res = await a.call(
      'POST',
      '/user/rekey',
      {
        strictness: 'strict',
        authHash: strict.authHash,
        wrappedVaultKey: { ct: toBase64Url(rewrapped.ct), nonce: toBase64Url(rewrapped.nonce) },
        commitments: strict.commitments,
      },
      plain.accessToken,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'step_up_required' });
  });

  test('a stale step-up', async () => {
    const a = await enrolledOnMedium();
    const token = await a.stepUpToken();
    CLOCK.value += 6 * 60_000;

    const strict = await material('strict', a.userSalt);
    const rewrapped = await wrapKey(
      a.vaultShare,
      strict.wrapKeyBytes,
      'cypherkey/wrap/vault-key/v1',
    );
    const res = await a.call(
      'POST',
      '/user/rekey',
      {
        strictness: 'strict',
        authHash: strict.authHash,
        wrappedVaultKey: { ct: toBase64Url(rewrapped.ct), nonce: toBase64Url(rewrapped.nonce) },
        commitments: strict.commitments,
      },
      token,
    );
    expect(res.status).toBe(403);
  });

  test('a commitment sequence of the wrong length', async () => {
    const a = await enrolledOnMedium();
    const token = await a.stepUpToken();
    const strict = await material('strict', a.userSalt);
    const rewrapped = await wrapKey(
      a.vaultShare,
      strict.wrapKeyBytes,
      'cypherkey/wrap/vault-key/v1',
    );

    const res = await a.call(
      'POST',
      '/user/rekey',
      {
        strictness: 'strict',
        authHash: strict.authHash,
        wrappedVaultKey: { ct: toBase64Url(rewrapped.ct), nonce: toBase64Url(rewrapped.nonce) },
        commitments: strict.commitments.slice(0, 5),
      },
      token,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'commitment_length_mismatch' });
  });

  test('no access token at all', async () => {
    const a = await enrolledOnMedium();
    const strict = await material('strict', a.userSalt);
    const rewrapped = await wrapKey(
      a.vaultShare,
      strict.wrapKeyBytes,
      'cypherkey/wrap/vault-key/v1',
    );
    const res = await a.call('POST', '/user/rekey', {
      strictness: 'strict',
      authHash: strict.authHash,
      wrappedVaultKey: { ct: toBase64Url(rewrapped.ct), nonce: toBase64Url(rewrapped.nonce) },
      commitments: strict.commitments,
    });
    expect(res.status).toBe(401);
  });
});

describe('Strict really is a different key', () => {
  test('the same passphrase and script derive different material under each level', async () => {
    const salt = randomBytes(16);
    const medium = await material('medium', salt);
    const relaxed = await material('relaxed', salt);
    const strict = await material('strict', salt);

    // Medium and Relaxed share a KDF input, so switching between them moves nothing.
    expect(relaxed.authHash).toBe(medium.authHash);
    expect(relaxed.commitments).toEqual(medium.commitments);

    expect(strict.authHash).not.toBe(medium.authHash);
    expect(strict.commitments).not.toEqual(medium.commitments);
  });
});
