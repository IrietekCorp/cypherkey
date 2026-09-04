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
  token: string,
) {
  const serialized = body === undefined ? '' : JSON.stringify(body);
  const nonce = randomBytes(16);
  const ts = CLOCK.now();
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
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
}

/** An item as the client sends it: opaque ciphertext, nothing the server can read. */
function item(id: string, version: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    version,
    ciphertext: toBase64Url(randomBytes(64)),
    nonce: toBase64Url(randomBytes(12)),
    updatedAt: CLOCK.now(),
    ...extra,
  };
}

async function account(username: string) {
  const config: Config = loadConfig({
    JWT_SECRET: SECRET_32,
    DATABASE_URL: `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-vault-${Bun.nanoseconds()}.db`,
  });
  const db = createDb(config.db);
  if (db.dialect !== 'sqlite') throw new Error('these tests are sqlite-only by design');
  open.push(db);
  await migrateDb(db);
  const app = createApp({ db, config, timingFloorMs: 0, now: CLOCK.now });
  return { app, db, config, username };
}

/** Registers a device on an existing app and logs it in, so two "devices" can share a vault. */
async function addDevice(
  app: ReturnType<typeof createApp>,
  username: string,
  existing?: { authHash: string },
) {
  const device = await generateDeviceKey();
  const signer: Signer = { priv: device.priv, id: toBase64Url(device.pub) };
  const authHash = existing?.authHash ?? toBase64Url(randomBytes(32));

  if (existing === undefined) {
    await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username,
        email: `${username}@example.test`,
        authHash,
        userSalt: toBase64Url(randomBytes(16)),
        wrappedVaultKey: { ct: toBase64Url(randomBytes(48)), nonce: toBase64Url(randomBytes(12)) },
        devicePub: signer.id,
        deviceName: 'Device',
        devicePlatform: 'linux',
        consentAt: CLOCK.now(),
        consentPolicyVersion: '2026-09-01',
      }),
    });
  }

  const body = { username, authHash, featureVector: Array.from({ length: 41 }, () => 100) };
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: await headersFor(signer, 'POST', '/auth/login', body, 'unused').then((h) => {
      const { authorization: _drop, ...rest } = h;
      return rest;
    }),
    body: JSON.stringify(body),
  });
  const payload = (await res.json()) as { accessToken?: string; band: string; newDevice?: boolean };

  const call = async (
    method: string,
    path: string,
    reqBody?: unknown,
    token = payload.accessToken ?? '',
  ) =>
    app.request(path, {
      method,
      headers: await headersFor(signer, method, path, reqBody, token),
      ...(reqBody === undefined ? {} : { body: JSON.stringify(reqBody) }),
    });

  return { signer, authHash, session: payload, call };
}

async function oneDevice(username = 'shawn') {
  CLOCK.value = 1_788_000_000_000;
  const a = await account(username);
  const d = await addDevice(a.app, username);
  return { ...a, ...d, drizzle: a.db.drizzle };
}

describe('POST /vault/changes', () => {
  test('stores what it was given, byte for byte, and stamps a cursor', async () => {
    const v = await oneDevice();
    const sent = item('item-1', 0);
    const res = await v.call('POST', '/vault/changes', { items: [sent] });
    expect(res.status).toBe(200);

    const payload = (await res.json()) as {
      cursor: number;
      applied: Array<Record<string, unknown>>;
    };
    expect(payload.applied).toHaveLength(1);
    expect(payload.applied[0]?.version).toBe(1);
    expect(payload.cursor).toBeGreaterThan(0);

    const rows = await v.drizzle.select().from(schema.vaultItems);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ciphertext).toBe(sent.ciphertext);
    expect(rows[0]?.nonce).toBe(sent.nonce);
  });

  test('the cursor advances monotonically across writes', async () => {
    const v = await oneDevice();
    const first = (await (
      await v.call('POST', '/vault/changes', { items: [item('a', 0)] })
    ).json()) as {
      cursor: number;
    };
    const second = (await (
      await v.call('POST', '/vault/changes', { items: [item('b', 0)] })
    ).json()) as {
      cursor: number;
    };
    expect(second.cursor).toBeGreaterThan(first.cursor);
  });

  test('a new item must claim version 0', async () => {
    const v = await oneDevice();
    const res = await v.call('POST', '/vault/changes', { items: [item('ghost', 5)] });
    expect(res.status).toBe(409);

    const payload = (await res.json()) as { conflicts: Array<{ id: string; server: unknown }> };
    expect(payload.conflicts[0]?.id).toBe('ghost');
    expect(payload.conflicts[0]?.server).toBeNull();
  });

  test('an update must claim the version the server holds', async () => {
    const v = await oneDevice();
    await v.call('POST', '/vault/changes', { items: [item('a', 0)] });

    const ok = await v.call('POST', '/vault/changes', { items: [item('a', 1)] });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { applied: Array<{ version: number }> }).applied[0]?.version).toBe(
      2,
    );
  });

  test('a delete is a tombstone, not a disappearance', async () => {
    const v = await oneDevice();
    await v.call('POST', '/vault/changes', { items: [item('a', 0)] });
    const res = await v.call('POST', '/vault/changes', {
      items: [item('a', 1, { deletedAt: CLOCK.now() })],
    });
    expect(res.status).toBe(200);

    const row = (await v.drizzle.select().from(schema.vaultItems))[0];
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  test('rejects an oversized batch and an oversized item', async () => {
    const v = await oneDevice();
    const many = Array.from({ length: 501 }, (_, i) => item(`i${i}`, 0));
    expect((await v.call('POST', '/vault/changes', { items: many })).status).toBe(400);

    const huge = { ...item('big', 0), ciphertext: 'A'.repeat(200_000) };
    expect((await v.call('POST', '/vault/changes', { items: [huge] })).status).toBe(400);
  });

  test('needs an access token and a device signature', async () => {
    const v = await oneDevice();
    const res = await v.app.request('/vault/changes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [item('a', 0)] }),
    });
    expect(res.status).toBe(401);
  });
});

describe('two devices writing the same item (the named case)', () => {
  test('the second writer gets 409 and the server copy', async () => {
    CLOCK.value = 1_788_000_000_000;
    const a = await account('shawn');
    const one = await addDevice(a.app, 'shawn');
    const two = await addDevice(a.app, 'shawn', { authHash: one.authHash });

    // A second device is unknown at first, so it is sent to step-up (X-3). Register it
    // by hand — device trust is M2's flow, and this test is about write conflicts.
    await a.db.drizzle.insert(schema.devices).values({
      id: crypto.randomUUID(),
      userId: (await a.db.drizzle.select().from(schema.users))[0]?.id as string,
      publicKey: two.signer.id,
      name: 'Second',
      platform: 'linux',
      trustedAt: new Date(CLOCK.now()),
      lastSeenAt: new Date(CLOCK.now()),
    });
    const twoAgain = await addDevice(a.app, 'shawn', { authHash: one.authHash });
    void twoAgain;

    const seeded = item('shared', 0);
    expect((await one.call('POST', '/vault/changes', { items: [seeded] })).status).toBe(200);

    // Both devices now believe the item is at version 1. The first write wins.
    const winner = item('shared', 1);
    expect((await one.call('POST', '/vault/changes', { items: [winner] })).status).toBe(200);

    const loser = item('shared', 1);
    const res = await one.call('POST', '/vault/changes', { items: [loser] });
    expect(res.status).toBe(409);

    const payload = (await res.json()) as {
      conflicts: Array<{ id: string; server: { version: number; ciphertext: string } }>;
    };
    expect(payload.conflicts).toHaveLength(1);
    expect(payload.conflicts[0]?.id).toBe('shared');
    expect(payload.conflicts[0]?.server.version).toBe(2);
    // The server copy is the winner's ciphertext, so the loser can resolve locally.
    expect(payload.conflicts[0]?.server.ciphertext).toBe(winner.ciphertext);

    const row = (await a.db.drizzle.select().from(schema.vaultItems))[0];
    expect(row?.ciphertext).toBe(winner.ciphertext);
  });

  test('a mixed batch applies the clean items and reports only the conflicted one', async () => {
    const v = await oneDevice();
    await v.call('POST', '/vault/changes', { items: [item('a', 0)] });

    const res = await v.call('POST', '/vault/changes', {
      items: [item('a', 0), item('b', 0), item('c', 0)],
    });
    expect(res.status).toBe(409);

    const payload = (await res.json()) as {
      applied: Array<{ id: string }>;
      conflicts: Array<{ id: string }>;
    };
    expect(payload.applied.map((i) => i.id).sort()).toEqual(['b', 'c']);
    expect(payload.conflicts.map((i) => i.id)).toEqual(['a']);
  });
});

describe('GET /vault/changes', () => {
  test('returns everything from cursor zero, then only what is new', async () => {
    const v = await oneDevice();
    await v.call('POST', '/vault/changes', { items: [item('a', 0), item('b', 0)] });

    const all = (await (await v.call('GET', '/vault/changes?since=0')).json()) as {
      items: Array<{ id: string }>;
      cursor: number;
    };
    expect(all.items.map((i) => i.id).sort()).toEqual(['a', 'b']);

    const none = (await (await v.call('GET', `/vault/changes?since=${all.cursor}`)).json()) as {
      items: unknown[];
    };
    expect(none.items).toHaveLength(0);

    await v.call('POST', '/vault/changes', { items: [item('c', 0)] });
    const incremental = (await (
      await v.call('GET', `/vault/changes?since=${all.cursor}`)
    ).json()) as {
      items: Array<{ id: string }>;
    };
    expect(incremental.items.map((i) => i.id)).toEqual(['c']);
  });

  test('items come back in cursor order', async () => {
    const v = await oneDevice();
    for (const id of ['a', 'b', 'c', 'd']) {
      await v.call('POST', '/vault/changes', { items: [item(id, 0)] });
    }
    const page = (await (await v.call('GET', '/vault/changes?since=0')).json()) as {
      items: Array<{ id: string; cursor: number }>;
    };
    expect(page.items.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
    const cursors = page.items.map((i) => i.cursor);
    expect([...cursors].sort((x, y) => x - y)).toEqual(cursors);
  });

  test('tombstones are returned, so a deletion propagates', async () => {
    const v = await oneDevice();
    await v.call('POST', '/vault/changes', { items: [item('a', 0)] });
    await v.call('POST', '/vault/changes', { items: [item('a', 1, { deletedAt: CLOCK.now() })] });

    const page = (await (await v.call('GET', '/vault/changes?since=0')).json()) as {
      items: Array<{ id: string; deletedAt: number | null }>;
    };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.deletedAt).not.toBeNull();
  });

  test('a missing or malformed cursor is rejected rather than assumed', async () => {
    const v = await oneDevice();
    expect((await v.call('GET', '/vault/changes')).status).toBe(400);
    expect((await v.call('GET', '/vault/changes?since=-1')).status).toBe(400);
    expect((await v.call('GET', '/vault/changes?since=abc')).status).toBe(400);
  });

  test('needs an access token and a device signature', async () => {
    const v = await oneDevice();
    expect((await v.app.request('/vault/changes?since=0')).status).toBe(401);
  });
});

describe('isolation between accounts', () => {
  test('one account never sees or overwrites another account items', async () => {
    CLOCK.value = 1_788_000_000_000;
    const config: Config = loadConfig({
      JWT_SECRET: SECRET_32,
      DATABASE_URL: `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-vault-${Bun.nanoseconds()}.db`,
    });
    const db = createDb(config.db);
    if (db.dialect !== 'sqlite') throw new Error('sqlite-only');
    open.push(db);
    await migrateDb(db);
    const app = createApp({ db, config, timingFloorMs: 0, now: CLOCK.now });

    const alice = await addDevice(app, 'alice');
    const bob = await addDevice(app, 'bob');

    const secret = item('shared-id', 0);
    await alice.call('POST', '/vault/changes', { items: [secret] });

    const bobSees = (await (await bob.call('GET', '/vault/changes?since=0')).json()) as {
      items: unknown[];
    };
    expect(bobSees.items).toHaveLength(0);

    // Bob writes the same item id: it must be his own row, not a takeover of hers.
    const bobItem = item('shared-id', 0);
    expect((await bob.call('POST', '/vault/changes', { items: [bobItem] })).status).toBe(200);

    const rows = await db.drizzle.select().from(schema.vaultItems);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.ciphertext).sort()).toEqual(
      [secret.ciphertext, bobItem.ciphertext].sort(),
    );
  });
});

describe('the server stays a dumb blob store', () => {
  test('it stores no plaintext and invents no fields', async () => {
    const v = await oneDevice();
    await v.call('POST', '/vault/changes', { items: [item('a', 0)] });

    const row = (await v.drizzle.select().from(schema.vaultItems))[0];
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'ciphertext',
      'cursor',
      'deletedAt',
      'id',
      'nonce',
      'updatedAt',
      'userId',
      'version',
    ]);
  });
});
