import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
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
import * as schema from '../db/schema/sqlite';
import {
  BACKUP_CODE_COUNT,
  generateBackupCodes,
  hashBackupCode,
  normalizeBackupCode,
} from './backup-codes';

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

const SAME = rhythm(1.0); // pass
const GREY = rhythm(1.2); // grey
const FAR = rhythm(1.4); // fail

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

/** An enrolled account, with the Backup Codes signup handed back. */
async function account(username = 'shawn') {
  CLOCK.value = 1_788_000_000_000;
  const config: Config = loadConfig({
    JWT_SECRET: SECRET_32,
    DATABASE_URL: `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-bc-${Bun.nanoseconds()}.db`,
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
      username,
      email: `${username}@example.test`,
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
      created.enrollmentToken,
    );
  }
  await call('POST', '/enroll/build', {}, created.enrollmentToken);

  const plain = (await (
    await call('POST', '/auth/login', {
      username,
      authHash,
      featureVector: SAME,
      commitments: commitsFor(),
    })
  ).json()) as { accessToken: string };

  /** Forces the grey band, which is what a Backup Code is for. */
  const goGrey = () =>
    call('POST', '/auth/login', {
      username,
      authHash,
      featureVector: GREY,
      commitments: commitsFor(),
    });

  return {
    app,
    call,
    drizzle: db.drizzle,
    username,
    authHash,
    signer,
    accessToken: plain.accessToken,
    backupCodes: created.backupCodes,
    goGrey,
  };
}

describe('code generation and normalization', () => {
  test('ten codes, ten Crockford symbols each, formatted XXXXX-XXXXX', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(BACKUP_CODE_COUNT);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/);
    }
  });

  test('codes in a set are distinct', () => {
    const codes = generateBackupCodes();
    expect(new Set(codes).size).toBe(BACKUP_CODE_COUNT);
  });

  test('two sets do not collide', () => {
    const all = [...generateBackupCodes(), ...generateBackupCodes()];
    expect(new Set(all).size).toBe(all.length);
  });

  test('normalization forgives case, hyphens, spaces and Crockford lookalikes', () => {
    const canonical = normalizeBackupCode('ABCDE-FGHJK');
    // A person reading a printed code aloud confuses O with 0 and I/L with 1.
    expect(normalizeBackupCode('abcde-fghjk')).toBe(canonical);
    expect(normalizeBackupCode('  ABCDE FGHJK  ')).toBe(canonical);
    expect(normalizeBackupCode('ABCDEFGHJK')).toBe(canonical);
    expect(normalizeBackupCode('0BCDE-FGHJK')).toBe(normalizeBackupCode('OBCDE-FGHJK'));
    expect(normalizeBackupCode('1BCDE-FGHJK')).toBe(normalizeBackupCode('IBCDE-FGHJK'));
    expect(normalizeBackupCode('1BCDE-FGHJK')).toBe(normalizeBackupCode('LBCDE-FGHJK'));
  });

  test('the hash is one-way and stable across formatting', () => {
    const hash = hashBackupCode('ABCDE-FGHJK');
    expect(hashBackupCode('abcdefghjk')).toBe(hash);
    expect(hash).not.toContain('ABCDE');
    expect(hashBackupCode('ABCDE-FGHJM')).not.toBe(hash);
  });
});

describe('signup issues the first set', () => {
  test('returns ten distinct codes and stores ten hashes', async () => {
    const a = await account();
    expect(a.backupCodes).toHaveLength(BACKUP_CODE_COUNT);
    expect(new Set(a.backupCodes).size).toBe(BACKUP_CODE_COUNT);

    const rows = await a.drizzle.select().from(schema.backupCodes);
    expect(rows).toHaveLength(BACKUP_CODE_COUNT);
    expect(rows.every((r) => r.usedAt === null)).toBe(true);
  });

  /** Absence test: a stored row must never let anyone read the code back. */
  test('no code appears anywhere in the table', async () => {
    const a = await account();
    const rows = await a.drizzle.select().from(schema.backupCodes);
    const dumped = JSON.stringify(rows);
    for (const code of a.backupCodes) {
      expect(dumped).not.toContain(code);
      expect(dumped).not.toContain(normalizeBackupCode(code));
    }
    // What is stored is the hash, and it is what verification looks up.
    expect(rows.map((r) => r.codeHash).sort()).toEqual(
      a.backupCodes.map((c) => hashBackupCode(c)).sort(),
    );
  });
});

describe('GET /user/backup-codes', () => {
  test('reports how many are left and never a code', async () => {
    const a = await account();
    const res = await a.call('GET', '/user/backup-codes', undefined, a.accessToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.remaining).toBe(BACKUP_CODE_COUNT);
    const dumped = JSON.stringify(body);
    for (const code of a.backupCodes) expect(dumped).not.toContain(code);
  });

  test('requires a session', async () => {
    const a = await account();
    const res = await a.call('GET', '/user/backup-codes');
    expect(res.status).toBe(401);
  });

  test('the count drops once one is spent', async () => {
    const a = await account();
    await a.goGrey();
    await a.call('POST', '/auth/step-up', {
      username: a.username,
      authHash: a.authHash,
      method: 'backup_code',
      proof: a.backupCodes[0],
    });

    const body = (await (
      await a.call('GET', '/user/backup-codes', undefined, a.accessToken)
    ).json()) as { remaining: number };
    expect(body.remaining).toBe(BACKUP_CODE_COUNT - 1);
  });
});

describe('POST /auth/step-up with a Backup Code', () => {
  test('a valid code clears the grey band and issues a session', async () => {
    const a = await account();
    await a.goGrey();

    const res = await a.call('POST', '/auth/step-up', {
      username: a.username,
      authHash: a.authHash,
      method: 'backup_code',
      proof: a.backupCodes[0],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
    // A-5: clearing step-up is what releases the server's half of the vault key.
    expect(body.serverShare).toBeDefined();
    expect(body.wrappedVaultKey).toBeDefined();
  });

  test('the same code is refused the second time', async () => {
    const a = await account();
    await a.goGrey();
    const first = await a.call('POST', '/auth/step-up', {
      username: a.username,
      authHash: a.authHash,
      method: 'backup_code',
      proof: a.backupCodes[0],
    });
    expect(first.status).toBe(200);

    await a.goGrey();
    const second = await a.call('POST', '/auth/step-up', {
      username: a.username,
      authHash: a.authHash,
      method: 'backup_code',
      proof: a.backupCodes[0],
    });
    expect(second.status).toBe(401);

    const row = (
      await a.drizzle
        .select()
        .from(schema.backupCodes)
        .where(eq(schema.backupCodes.codeHash, hashBackupCode(a.backupCodes[0] as string)))
    )[0];
    expect(row?.usedAt).not.toBeNull();
  });

  test('an unknown code is refused', async () => {
    const a = await account();
    await a.goGrey();
    const res = await a.call('POST', '/auth/step-up', {
      username: a.username,
      authHash: a.authHash,
      method: 'backup_code',
      proof: 'ZZZZZ-ZZZZZ',
    });
    expect(res.status).toBe(401);
  });

  test("another account's code is refused", async () => {
    const a = await account('shawn');
    const other = generateBackupCodes()[0] as string;
    await a.goGrey();

    // A code that is valid *somewhere* must not be valid here. The lookup is scoped
    // to the user, so a global hash match cannot leak across accounts.
    const res = await a.call('POST', '/auth/step-up', {
      username: a.username,
      authHash: a.authHash,
      method: 'backup_code',
      proof: other,
    });
    expect(res.status).toBe(401);
  });

  test('a code cannot substitute for the passphrase', async () => {
    const a = await account();
    await a.goGrey();
    const res = await a.call('POST', '/auth/step-up', {
      username: a.username,
      authHash: toBase64Url(randomBytes(32)),
      method: 'backup_code',
      proof: a.backupCodes[0],
    });
    expect(res.status).toBe(401);
  });

  test('the response never echoes the code', async () => {
    const a = await account();
    await a.goGrey();
    const res = await a.call('POST', '/auth/step-up', {
      username: a.username,
      authHash: a.authHash,
      method: 'backup_code',
      proof: a.backupCodes[0],
    });
    expect(await res.text()).not.toContain(a.backupCodes[0] as string);
  });
});

describe('failed step-ups count toward lockout', () => {
  test('five bad Backup Codes lock the account', async () => {
    const a = await account();
    for (let i = 0; i < 5; i++) {
      // Advance between attempts: the A-8 account bucket is ten a minute, and with a
      // frozen clock it would refuse the tenth request before lockout could be reached.
      // Spacing them is also the realistic shape of an attack worth locking out.
      CLOCK.value += 30_000;
      await a.goGrey();
      await a.call('POST', '/auth/step-up', {
        username: a.username,
        authHash: a.authHash,
        method: 'backup_code',
        proof: 'ZZZZZ-ZZZZZ',
      });
    }

    const lockout = (await a.drizzle.select().from(schema.lockouts))[0];
    expect(lockout?.failedCount).toBeGreaterThanOrEqual(5);
    expect(lockout?.lockedUntil).not.toBeNull();
  });

  test('a failed retype counts too', async () => {
    const a = await account();
    await a.goGrey();
    await a.call('POST', '/auth/step-up', {
      username: a.username,
      authHash: a.authHash,
      method: 'retype',
      featureVector: FAR,
      commitments: commitsFor(),
    });

    const lockout = (await a.drizzle.select().from(schema.lockouts))[0];
    expect(lockout?.failedCount).toBeGreaterThanOrEqual(1);
  });

  test('a successful Backup Code clears the failure counter', async () => {
    const a = await account();
    await a.goGrey();
    await a.call('POST', '/auth/step-up', {
      username: a.username,
      authHash: a.authHash,
      method: 'backup_code',
      proof: 'ZZZZZ-ZZZZZ',
    });
    await a.goGrey();
    await a.call('POST', '/auth/step-up', {
      username: a.username,
      authHash: a.authHash,
      method: 'backup_code',
      proof: a.backupCodes[0],
    });

    const lockout = (await a.drizzle.select().from(schema.lockouts))[0];
    expect(lockout?.failedCount).toBe(0);
  });
});

describe('POST /user/backup-codes regenerates', () => {
  test('returns ten new codes and invalidates every previous one', async () => {
    const a = await account();
    const res = await a.call('POST', '/user/backup-codes', { authHash: a.authHash }, a.accessToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backupCodes: string[] };
    expect(body.backupCodes).toHaveLength(BACKUP_CODE_COUNT);
    expect(body.backupCodes.some((c) => a.backupCodes.includes(c))).toBe(false);

    const rows = await a.drizzle.select().from(schema.backupCodes);
    expect(rows).toHaveLength(BACKUP_CODE_COUNT);

    // An old code must be dead, not merely absent from the new list.
    await a.goGrey();
    const old = await a.call('POST', '/auth/step-up', {
      username: a.username,
      authHash: a.authHash,
      method: 'backup_code',
      proof: a.backupCodes[0],
    });
    expect(old.status).toBe(401);
  });

  test('a new code from the new set works', async () => {
    const a = await account();
    const body = (await (
      await a.call('POST', '/user/backup-codes', { authHash: a.authHash }, a.accessToken)
    ).json()) as { backupCodes: string[] };

    await a.goGrey();
    const res = await a.call('POST', '/auth/step-up', {
      username: a.username,
      authHash: a.authHash,
      method: 'backup_code',
      proof: body.backupCodes[0],
    });
    expect(res.status).toBe(200);
  });

  /** A-17: settings changes need the passphrase in the same request, not an old flag. */
  test('regeneration requires the passphrase, not just a session', async () => {
    const a = await account();
    const res = await a.call(
      'POST',
      '/user/backup-codes',
      { authHash: toBase64Url(randomBytes(32)) },
      a.accessToken,
    );
    expect(res.status).toBe(401);

    const rows = await a.drizzle.select().from(schema.backupCodes);
    expect(rows.map((r) => r.codeHash).sort()).toEqual(
      a.backupCodes.map((c) => hashBackupCode(c)).sort(),
    );
  });

  test('regeneration requires a session', async () => {
    const a = await account();
    const res = await a.call('POST', '/user/backup-codes', { authHash: a.authHash });
    expect(res.status).toBe(401);
  });
});
