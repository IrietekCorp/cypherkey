import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { extractFeatures } from '../../../core/biometrics/features';
import type { KeyEvent } from '../../../core/biometrics/types';
import { generateDeviceKey, signRequest } from '../../../core/crypto/device';
import { toBase64Url, utf8Encode } from '../../../core/crypto/encoding';
import { randomBytes } from '../../../core/crypto/kdf';
import {
  generateRecoveryCode,
  recoveryAuthHashFromKey,
  recoveryKeyFromCode,
} from '../../../core/crypto/recovery';
import { createApp } from '../app';
import { type Config, loadConfig } from '../config';
import type { Db } from '../db/client';
import { createDb } from '../db/client';
import { migrateDb } from '../db/migrate';
import * as schema from '../db/schema/sqlite';
import { hashBackupCode } from './backup-codes';

const SECRET_32 = 'x'.repeat(32);
const SCRIPT_LEN = 12;
const CLOCK = { value: 1_788_000_000_000, now: () => CLOCK.value };

const commitsFor = (n = SCRIPT_LEN) =>
  Array.from({ length: n }, (_, i) => toBase64Url(new Uint8Array(16).fill(i + 1)));

function rhythm(scale: number): number[] {
  const events: KeyEvent[] = [];
  const dwell = Math.round(80 * scale);
  const gap = Math.round(120 * scale);
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

const SAME = rhythm(1.0);

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

/** An enrolled account holding a registered Recovery Kit. */
async function account() {
  CLOCK.value = 1_788_000_000_000;
  const config: Config = loadConfig({
    JWT_SECRET: SECRET_32,
    DATABASE_URL: `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-rec-${Bun.nanoseconds()}.db`,
  });
  const db = createDb(config.db);
  if (db.dialect !== 'sqlite') throw new Error('these tests are sqlite-only by design');
  open.push(db);
  await migrateDb(db);
  const app = createApp({ db, config, timingFloorMs: 0, now: CLOCK.now });

  const device = await generateDeviceKey();
  const signer: Signer = { priv: device.priv, id: toBase64Url(device.pub) };
  const authHash = toBase64Url(randomBytes(32));
  const username = 'shawn';

  const signup = await app.request('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
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
  const created = (await signup.json()) as { enrollmentToken: string; backupCodes: string[] };

  const call = async (method: string, path: string, body?: unknown, token?: string) =>
    app.request(path, {
      method,
      headers: await headersFor(signer, method, path, body, token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const post = async (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // The Recovery Kit, and the verifier that proves possession of it.
  const recoveryCode = generateRecoveryCode();
  const recoveryKey = await recoveryKeyFromCode(recoveryCode);
  const recoveryAuthHash = toBase64Url(await recoveryAuthHashFromKey(recoveryKey));
  const recoveryWrappedVaultKey = {
    ct: toBase64Url(randomBytes(48)),
    nonce: toBase64Url(randomBytes(12)),
  };
  await call('POST', '/auth/recovery-key', { recoveryWrappedVaultKey, recoveryAuthHash });

  for (let i = 0; i < config.enrollmentSamples; i++) {
    await call(
      'POST',
      '/enroll/sample',
      { featureVector: SAME, commitments: commitsFor() },
      created.enrollmentToken,
    );
  }
  await call('POST', '/enroll/build', {}, created.enrollmentToken);

  const newDevice = await generateDeviceKey();

  return {
    app,
    call,
    post,
    drizzle: db.drizzle,
    config,
    username,
    authHash,
    signer,
    recoveryAuthHash,
    recoveryWrappedVaultKey,
    backupCodes: created.backupCodes,
    newSigner: { priv: newDevice.priv, id: toBase64Url(newDevice.pub) } as Signer,
    /**
     * X-5: recovery retires the old Kit and issues a new one, so a body always carries
     * a replacement. `kit` is the code the caller would be shown afterwards.
     */
    recoverBody: async (over: Record<string, unknown> = {}) => {
      const kit = generateRecoveryCode();
      const key = await recoveryKeyFromCode(kit);
      return {
        kit,
        body: {
          username,
          recoveryAuthHash,
          newAuthHash: toBase64Url(randomBytes(32)),
          newUserSalt: toBase64Url(randomBytes(16)),
          newWrappedVaultKey: {
            ct: toBase64Url(randomBytes(48)),
            nonce: toBase64Url(randomBytes(12)),
          },
          devicePub: toBase64Url(newDevice.pub),
          deviceName: 'Recovered laptop',
          devicePlatform: 'linux',
          newRecoveryWrappedVaultKey: {
            ct: toBase64Url(randomBytes(48)),
            nonce: toBase64Url(randomBytes(12)),
          },
          newRecoveryAuthHash: toBase64Url(await recoveryAuthHashFromKey(key)),
          ...over,
        },
      };
    },
  };
}

describe('POST /auth/recover/begin', () => {
  test('a correct Kit gets the blob and the server share', async () => {
    const a = await account();
    const res = await a.post('/auth/recover/begin', {
      username: a.username,
      recoveryAuthHash: a.recoveryAuthHash,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.recoveryWrappedVaultKey).toEqual(a.recoveryWrappedVaultKey);
    expect(body.serverShare).toBeDefined();
  });

  test('a wrong Kit is 401 and returns no blob', async () => {
    const a = await account();
    const res = await a.post('/auth/recover/begin', {
      username: a.username,
      recoveryAuthHash: toBase64Url(randomBytes(32)),
    });

    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(a.recoveryWrappedVaultKey.ct);
    expect(text).not.toContain('serverShare');
  });

  test('an unknown username answers exactly as a wrong Kit does', async () => {
    const a = await account();
    const unknown = await a.post('/auth/recover/begin', {
      username: 'nobody',
      recoveryAuthHash: a.recoveryAuthHash,
    });
    const wrong = await a.post('/auth/recover/begin', {
      username: a.username,
      recoveryAuthHash: toBase64Url(randomBytes(32)),
    });

    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.text()).toBe(await wrong.text());
  });

  /** The requirement: no factor, device, key or profile may move before proof. */
  test('begin mutates nothing at all', async () => {
    const a = await account();
    const snapshot = async () =>
      JSON.stringify({
        users: await a.drizzle.select().from(schema.users),
        devices: await a.drizzle.select().from(schema.devices),
        profiles: await a.drizzle.select().from(schema.biometricProfiles),
        factors: await a.drizzle.select().from(schema.stepUpFactors),
        codes: await a.drizzle.select().from(schema.backupCodes),
        tokens: await a.drizzle.select().from(schema.refreshTokens),
      });

    const before = await snapshot();
    await a.post('/auth/recover/begin', {
      username: a.username,
      recoveryAuthHash: a.recoveryAuthHash,
    });
    expect(await snapshot()).toBe(before);
  });
});

describe('POST /auth/recover', () => {
  test('a correct Kit recovers, and the new passphrase logs in', async () => {
    const a = await account();
    const { body } = await a.recoverBody();
    const res = await a.post('/auth/recover', body);
    expect(res.status).toBe(200);

    const out = (await res.json()) as { enrollmentToken: string; serverShare: string };
    expect(out.enrollmentToken).toBeDefined();

    // X-5 requires a fresh enrolment, so log in only after re-enrolling.
    const call = async (method: string, path: string, b?: unknown, token?: string) =>
      a.app.request(path, {
        method,
        headers: await headersFor(a.newSigner, method, path, b, token),
        ...(b === undefined ? {} : { body: JSON.stringify(b) }),
      });
    for (let i = 0; i < a.config.enrollmentSamples; i++) {
      await call(
        'POST',
        '/enroll/sample',
        { featureVector: SAME, commitments: commitsFor() },
        out.enrollmentToken,
      );
    }
    await call('POST', '/enroll/build', {}, out.enrollmentToken);

    const login = await call('POST', '/auth/login', {
      username: a.username,
      authHash: body.newAuthHash,
      featureVector: SAME,
      commitments: commitsFor(),
    });
    expect(login.status).toBe(200);
  });

  test('the old passphrase no longer works', async () => {
    const a = await account();
    await a.post('/auth/recover', (await a.recoverBody()).body);

    const login = await a.call('POST', '/auth/login', {
      username: a.username,
      authHash: a.authHash,
      featureVector: SAME,
      commitments: commitsFor(),
    });
    expect(login.status).toBe(401);
  });

  test('a wrong Kit changes nothing', async () => {
    const a = await account();
    const before = JSON.stringify(await a.drizzle.select().from(schema.users));
    const res = await a.post(
      '/auth/recover',
      (await a.recoverBody({ recoveryAuthHash: toBase64Url(randomBytes(32)) })).body,
    );

    expect(res.status).toBe(401);
    expect(JSON.stringify(await a.drizzle.select().from(schema.users))).toBe(before);
  });

  test('every previous device is revoked and the presenting one is registered', async () => {
    const a = await account();
    const { body } = await a.recoverBody();
    await a.post('/auth/recover', body);

    const devices = await a.drizzle.select().from(schema.devices);
    const old = devices.find((d) => d.publicKey === a.signer.id);
    const fresh = devices.find((d) => d.publicKey === body.devicePub);
    expect(old?.revokedAt).not.toBeNull();
    expect(fresh).toBeDefined();
    expect(fresh?.revokedAt).toBeNull();
  });

  test('the biometric profile is gone and enrollment starts over', async () => {
    const a = await account();
    const out = (await (await a.post('/auth/recover', (await a.recoverBody()).body)).json()) as {
      enrollmentToken: string;
    };

    expect(await a.drizzle.select().from(schema.biometricProfiles)).toHaveLength(0);
    expect(await a.drizzle.select().from(schema.enrollmentSamples)).toHaveLength(0);

    const status = await a.app.request('/enroll/status', {
      method: 'GET',
      headers: await headersFor(
        a.newSigner,
        'GET',
        '/enroll/status',
        undefined,
        out.enrollmentToken,
      ),
    });
    const body = (await status.json()) as { built: boolean; submitted: number };
    expect(body.built).toBe(false);
    expect(body.submitted).toBe(0);
  });

  test('an enrolled TOTP factor is deleted; Backup Codes survive', async () => {
    const a = await account();
    // A-17: a TOTP secret is encrypted under a key derived from the lost passphrase, so
    // it is unreachable and must not be left behind to lock the account out.
    await a.drizzle.insert(schema.stepUpFactors).values({
      id: crypto.randomUUID(),
      userId: (await a.drizzle.select().from(schema.users))[0]?.id as string,
      type: 'totp',
      secretEnc: 'unreachable-after-recovery',
      createdAt: new Date(CLOCK.now()),
    });

    await a.post('/auth/recover', (await a.recoverBody()).body);

    expect(await a.drizzle.select().from(schema.stepUpFactors)).toHaveLength(0);
    // Backup Codes are sha256 hashes and owe nothing to the passphrase.
    const codes = await a.drizzle.select().from(schema.backupCodes);
    expect(codes).toHaveLength(10);
    expect(codes.map((r) => r.codeHash).sort()).toEqual(
      a.backupCodes.map((c) => hashBackupCode(c)).sort(),
    );
  });

  test('the key version is bumped and serverShare is unchanged', async () => {
    const a = await account();
    const before = (await a.drizzle.select().from(schema.users))[0];
    await a.post('/auth/recover', (await a.recoverBody()).body);
    const after = (await a.drizzle.select().from(schema.users))[0];

    expect(after?.keyVersion).toBe((before?.keyVersion ?? 0) + 1);
    // vaultKey never changed, so the vault is not re-encrypted and the share stands.
    expect(after?.serverShare).toBe(before?.serverShare as string);
  });

  test('nothing in the response or the tables carries the Kit', async () => {
    const a = await account();
    const res = await a.post('/auth/recover', (await a.recoverBody()).body);
    const text = await res.text();
    expect(text).not.toContain(a.recoveryAuthHash);

    const users = JSON.stringify(await a.drizzle.select().from(schema.users));
    expect(users).not.toContain(a.recoveryAuthHash);
    // What is stored is Argon2id over it, which is not the value itself.
    const row = (await a.drizzle.select().from(schema.users))[0];
    expect(row?.recoveryAuthHash?.startsWith('$argon2id$')).toBe(true);
  });
});

describe('lockout and hardening', () => {
  test('five wrong Kits lock the account', async () => {
    const a = await account();
    for (let i = 0; i < 5; i++) {
      // Spaced, or the A-8 account bucket refuses the request before lockout is reached.
      CLOCK.value += 30_000;
      await a.post('/auth/recover/begin', {
        username: a.username,
        recoveryAuthHash: toBase64Url(randomBytes(32)),
      });
    }

    const lockout = (await a.drizzle.select().from(schema.lockouts))[0];
    expect(lockout?.failedCount).toBeGreaterThanOrEqual(5);
    expect(lockout?.lockedUntil).not.toBeNull();

    // Even the correct Kit is refused while locked.
    const res = await a.post('/auth/recover/begin', {
      username: a.username,
      recoveryAuthHash: a.recoveryAuthHash,
    });
    expect(res.status).toBe(429);
  });

  test('a successful recovery clears the failure counter', async () => {
    const a = await account();
    CLOCK.value += 30_000;
    await a.post('/auth/recover/begin', {
      username: a.username,
      recoveryAuthHash: toBase64Url(randomBytes(32)),
    });
    CLOCK.value += 30_000;
    await a.post('/auth/recover', (await a.recoverBody()).body);

    const lockout = (await a.drizzle.select().from(schema.lockouts))[0];
    expect(lockout?.failedCount).toBe(0);
  });

  test('an account with no registered Kit cannot be recovered', async () => {
    const config: Config = loadConfig({
      JWT_SECRET: SECRET_32,
      DATABASE_URL: `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-rec-nokit-${Bun.nanoseconds()}.db`,
    });
    const db = createDb(config.db);
    open.push(db);
    await migrateDb(db);
    const app = createApp({ db, config, timingFloorMs: 0, now: CLOCK.now });
    const device = await generateDeviceKey();

    await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'nokit',
        email: 'nokit@example.test',
        authHash: toBase64Url(randomBytes(32)),
        userSalt: toBase64Url(randomBytes(16)),
        wrappedVaultKey: {
          ct: toBase64Url(randomBytes(48)),
          nonce: toBase64Url(randomBytes(12)),
        },
        devicePub: toBase64Url(device.pub),
        deviceName: 'Laptop',
        devicePlatform: 'linux',
        consentAt: CLOCK.now(),
        consentPolicyVersion: '2026-09-01',
      }),
    });

    const res = await app.request('/auth/recover/begin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'nokit',
        recoveryAuthHash: toBase64Url(randomBytes(32)),
      }),
    });
    expect(res.status).toBe(401);
  });
});

/**
 * The transaction is the requirement, and it is easy to break invisibly.
 *
 * `bun:sqlite` is a synchronous driver. Drizzle's sqlite `transaction()` given an
 * *async* callback returns before the promise settles, so the writes land outside
 * transactional control and a throw rolls back nothing at all — measured during this
 * ticket, not assumed. The route therefore uses a synchronous body on sqlite, and this
 * test fails if anyone converts it back.
 */
describe('the recovery transaction is all-or-nothing', () => {
  test('a failure partway through leaves the account exactly as it was', async () => {
    const a = await account();
    const userId = (await a.drizzle.select().from(schema.users))[0]?.id as string;

    // Give the account a TOTP factor, so step 1 of the transaction has real work to do
    // and its rollback is observable.
    await a.drizzle.insert(schema.stepUpFactors).values({
      id: crypto.randomUUID(),
      userId,
      type: 'totp',
      secretEnc: 'unreachable-after-recovery',
      createdAt: new Date(CLOCK.now()),
    });

    const snapshot = async () =>
      JSON.stringify({
        users: await a.drizzle.select().from(schema.users),
        devices: await a.drizzle.select().from(schema.devices),
        factors: await a.drizzle.select().from(schema.stepUpFactors),
        profiles: await a.drizzle.select().from(schema.biometricProfiles),
        samples: await a.drizzle.select().from(schema.enrollmentSamples),
        tokens: await a.drizzle.select().from(schema.refreshTokens),
      });
    const before = await snapshot();

    // Force step 3 (registering the presenting device) to violate the primary key,
    // which throws after steps 1 and 2 have already written.
    const collision = crypto.randomUUID();
    await a.drizzle.insert(schema.devices).values({
      id: collision,
      userId,
      publicKey: toBase64Url(randomBytes(32)),
      name: 'squatter',
      platform: 'linux',
      trustedAt: new Date(CLOCK.now()),
      lastSeenAt: new Date(CLOCK.now()),
      revokedAt: null,
    });
    const withSquatter = await snapshot();

    const spy = spyOn(crypto, 'randomUUID').mockReturnValue(
      collision as ReturnType<typeof crypto.randomUUID>,
    );
    try {
      const res = await a.post('/auth/recover', (await a.recoverBody()).body);
      // However it surfaces, it must not be a success.
      expect(res.status).not.toBe(200);
    } catch {
      // A thrown insert is equally acceptable; what matters is the database after.
    } finally {
      spy.mockRestore();
    }

    // Every step must have been undone: the TOTP factor is still there, the old devices
    // are not revoked, the profile survives, and the passphrase is unchanged.
    expect(await snapshot()).toBe(withSquatter);
    expect(withSquatter).not.toBe(before); // the squatter really was added
    expect(await a.drizzle.select().from(schema.stepUpFactors)).toHaveLength(1);
    expect(await a.drizzle.select().from(schema.biometricProfiles)).toHaveLength(1);

    // And the account still works with the original passphrase.
    const login = await a.call('POST', '/auth/login', {
      username: a.username,
      authHash: a.authHash,
      featureVector: SAME,
      commitments: commitsFor(),
    });
    expect(login.status).toBe(200);
  });
});

/**
 * X-5: `vaultKey` never changes, so without this the old Kit would keep opening the
 * vault forever — and it was just typed into whatever context made recovery necessary.
 */
describe('recovery retires the old Recovery Kit', () => {
  test('the old Kit no longer authenticates', async () => {
    const a = await account();
    await a.post('/auth/recover', (await a.recoverBody()).body);

    const res = await a.post('/auth/recover/begin', {
      username: a.username,
      recoveryAuthHash: a.recoveryAuthHash,
    });
    expect(res.status).toBe(401);
  });

  test('the replacement Kit authenticates and returns the new blob', async () => {
    const a = await account();
    const { kit, body } = await a.recoverBody();
    await a.post('/auth/recover', body);

    const key = await recoveryKeyFromCode(kit);
    const res = await a.post('/auth/recover/begin', {
      username: a.username,
      recoveryAuthHash: toBase64Url(await recoveryAuthHashFromKey(key)),
    });

    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out.recoveryWrappedVaultKey).toEqual(body.newRecoveryWrappedVaultKey);
  });

  test('the stored verifier is replaced, not appended', async () => {
    const a = await account();
    const before = (await a.drizzle.select().from(schema.users))[0]?.recoveryAuthHash;
    await a.post('/auth/recover', (await a.recoverBody()).body);
    const after = (await a.drizzle.select().from(schema.users))[0]?.recoveryAuthHash;

    expect(after).not.toBe(before as string);
    expect(after?.startsWith('$argon2id$')).toBe(true);
  });

  test('recovering twice in a row works, each time with the newest Kit', async () => {
    const a = await account();
    const first = await a.recoverBody();
    await a.post('/auth/recover', first.body);

    // Round two, presenting the Kit issued by round one.
    const firstKey = await recoveryKeyFromCode(first.kit);
    const second = await a.recoverBody({
      recoveryAuthHash: toBase64Url(await recoveryAuthHashFromKey(firstKey)),
    });
    const res = await a.post('/auth/recover', second.body);
    expect(res.status).toBe(200);
  });

  test('a rolled-back recovery leaves the ORIGINAL Kit working', async () => {
    const a = await account();
    const userId = (await a.drizzle.select().from(schema.users))[0]?.id as string;

    const collision = crypto.randomUUID();
    await a.drizzle.insert(schema.devices).values({
      id: collision,
      userId,
      publicKey: toBase64Url(randomBytes(32)),
      name: 'squatter',
      platform: 'linux',
      trustedAt: new Date(CLOCK.now()),
      lastSeenAt: new Date(CLOCK.now()),
      revokedAt: null,
    });

    const spy = spyOn(crypto, 'randomUUID').mockReturnValue(
      collision as ReturnType<typeof crypto.randomUUID>,
    );
    try {
      await a.post('/auth/recover', (await a.recoverBody()).body);
    } catch {
      // The response does not matter; what matters is that the Kit still works.
    } finally {
      spy.mockRestore();
    }

    // Retiring the old Kit is part of the transaction, so a rollback must restore it.
    // Otherwise a failed recovery would strand the account with no way back at all.
    const res = await a.post('/auth/recover/begin', {
      username: a.username,
      recoveryAuthHash: a.recoveryAuthHash,
    });
    expect(res.status).toBe(200);
  });
});
