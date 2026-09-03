import { Database } from 'bun:sqlite';
import { type BunSQLiteDatabase, drizzle as drizzleSqlite } from 'drizzle-orm/bun-sqlite';
import { type PostgresJsDatabase, drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { DbConfig } from '../config';
import * as schema from './schema';

type Schema = typeof schema;

/** One open database, with the dialect it speaks. A-1.5: one schema, two drivers, no forks. */
export type Db =
  | {
      dialect: 'sqlite';
      drizzle: BunSQLiteDatabase<Schema>;
      ping(): Promise<void>;
      close(): Promise<void>;
    }
  | {
      dialect: 'postgres';
      drizzle: PostgresJsDatabase<Schema>;
      ping(): Promise<void>;
      close(): Promise<void>;
    };

/** Opens the database named by the config. Connects lazily on Postgres to keep cold start under A-15's budget. */
export function createDb(config: DbConfig): Db {
  if (config.dialect === 'sqlite') {
    const client = new Database(config.path);
    client.exec('PRAGMA journal_mode = WAL;');
    client.exec('PRAGMA foreign_keys = ON;');
    return {
      dialect: 'sqlite',
      drizzle: drizzleSqlite(client, { schema }),
      ping: async () => {
        client.query('select 1').get();
      },
      close: async () => {
        client.close();
      },
    };
  }

  const client = postgres(config.url, { max: 10, onnotice: () => {} });
  return {
    dialect: 'postgres',
    drizzle: drizzlePostgres(client, { schema }),
    ping: async () => {
      await client`select 1`;
    },
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}
