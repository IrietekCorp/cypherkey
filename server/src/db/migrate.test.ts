import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config';
import { noPostgres, postgresUrl } from '../testing/postgres';
import type { Db } from './client';
import { createDb } from './client';
import { migrateDb } from './migrate';
import * as pgSchema from './schema/pg';
import * as sqliteSchema from './schema/sqlite';

const SECRET_32 = 'x'.repeat(32);
type NewUser = typeof sqliteSchema.users.$inferInsert;

const open: Db[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.close()));
});

/** Same row, either dialect — the point of A-1.5 is that this compiles for both. */
async function insertUser(db: Db, row: NewUser): Promise<void> {
  if (db.dialect === 'sqlite') await db.drizzle.insert(sqliteSchema.users).values(row);
  else await db.drizzle.insert(pgSchema.users).values(row);
}

async function findUser(db: Db, username: string) {
  const rows =
    db.dialect === 'sqlite'
      ? await db.drizzle
          .select()
          .from(sqliteSchema.users)
          .where(eq(sqliteSchema.users.username, username))
      : await db.drizzle.select().from(pgSchema.users).where(eq(pgSchema.users.username, username));
  return rows[0];
}

function sampleUser(username: string): NewUser {
  return {
    id: crypto.randomUUID(),
    username,
    email: `${username}@example.test`,
    userSalt: 'c2FsdA',
    authHash: '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA',
    wrappedVaultKey: { ct: 'Y3Q', nonce: 'bm9uY2U' },
    serverShare: 'c2hhcmU',
    consentAt: new Date('2026-09-03T00:00:00Z'),
    consentPolicyVersion: '2026-09-01',
    createdAt: new Date('2026-09-03T00:00:00Z'),
  };
}

/** The same four assertions run against whichever driver the caller supplies. */
function migrationSuite(dialect: Db['dialect'], url: () => string) {
  let db: Db;
  beforeAll(() => {
    db = createDb(loadConfig({ JWT_SECRET: SECRET_32, DATABASE_URL: url() }).db);
    open.push(db);
  });

  test('migrate brings an empty database up and is idempotent', async () => {
    await migrateDb(db);
    await migrateDb(db);
    expect(db.dialect).toBe(dialect);
  });

  test('insert and select a user round-trips every column type', async () => {
    const username = `alice-${Bun.nanoseconds()}`;
    await insertUser(db, sampleUser(username));
    const row = await findUser(db, username);

    expect(row?.username).toBe(username);
    expect(row?.wrappedVaultKey).toEqual({ ct: 'Y3Q', nonce: 'bm9uY2U' });
    expect(row?.consentPolicyVersion).toBe('2026-09-01');
    expect(row?.consentAt).toBeInstanceOf(Date);
  });

  test('applies the documented defaults', async () => {
    const username = `bob-${Bun.nanoseconds()}`;
    await insertUser(db, sampleUser(username));
    const row = await findUser(db, username);

    expect(row?.keyVersion).toBe(1);
    expect(row?.biometricEnabled).toBe(true);
    expect(row?.recoveryWrappedVaultKey).toBeNull();
    expect(row?.biometricPausedUntil).toBeNull();
  });

  test('username is unique', async () => {
    const username = `carol-${Bun.nanoseconds()}`;
    await insertUser(db, sampleUser(username));
    await expect(insertUser(db, sampleUser(username))).rejects.toThrow();
  });
}

describe('migrations on a fresh sqlite database', () => {
  migrationSuite(
    'sqlite',
    () => `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-migrate-${Bun.nanoseconds()}.db`,
  );
});

describe.skipIf(noPostgres)('migrations on a fresh postgres database', () => {
  migrationSuite('postgres', () => postgresUrl ?? '');
});
