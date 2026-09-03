import { fileURLToPath } from 'node:url';
import { migrate as migrateSqlite } from 'drizzle-orm/bun-sqlite/migrator';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import type { Db } from './client';

/** Generated SQL lives beside the schema it came from, one folder per dialect. */
function migrationsFolder(dialect: Db['dialect']): string {
  return fileURLToPath(new URL(`../../drizzle/${dialect}`, import.meta.url));
}

/** Brings a database up to the current schema. Idempotent; safe to run on every deploy. */
export async function migrateDb(db: Db): Promise<void> {
  if (db.dialect === 'sqlite') {
    migrateSqlite(db.drizzle, { migrationsFolder: migrationsFolder('sqlite') });
    return;
  }
  await migratePostgres(db.drizzle, { migrationsFolder: migrationsFolder('postgres') });
}
