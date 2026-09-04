import { defineConfig } from 'drizzle-kit';
import { parseDatabaseUrl } from './src/config';

// drizzle-kit runs outside the server process and needs only DATABASE_URL — never JWT_SECRET.
// Paths are relative to the repo root, because the package.json scripts run from there and
// drizzle-kit resolves `out` against the working directory, not against this file.
const db = parseDatabaseUrl(process.env.DATABASE_URL ?? 'sqlite://./cypherkey.db');

export default db.dialect === 'postgres'
  ? defineConfig({
      schema: 'server/src/db/schema/pg.ts',
      out: 'server/drizzle/postgres',
      dialect: 'postgresql',
      dbCredentials: { url: db.url },
    })
  : defineConfig({
      schema: 'server/src/db/schema/sqlite.ts',
      out: 'server/drizzle/sqlite',
      dialect: 'sqlite',
      dbCredentials: { url: db.path },
    });
