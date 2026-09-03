import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';
import { parseDatabaseUrl } from './src/config';

// drizzle-kit runs outside the server process and needs only DATABASE_URL — never JWT_SECRET.
// Paths are absolute so the config works from any working directory.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const db = parseDatabaseUrl(process.env.DATABASE_URL ?? 'sqlite://./cypherkey.db');

export default db.dialect === 'postgres'
  ? defineConfig({
      schema: here('./src/db/schema/pg.ts'),
      out: here('./drizzle/postgres'),
      dialect: 'postgresql',
      dbCredentials: { url: db.url },
    })
  : defineConfig({
      schema: here('./src/db/schema/sqlite.ts'),
      out: here('./drizzle/sqlite'),
      dialect: 'sqlite',
      dbCredentials: { url: db.path },
    });
