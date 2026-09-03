import { defineConfig } from 'drizzle-kit';
import { loadConfig } from './src/config';

// drizzle-kit runs outside the server process, so it needs the same env contract.
const { db } = loadConfig();

export default db.dialect === 'postgres'
  ? defineConfig({
      schema: './src/db/schema.ts',
      out: './drizzle',
      dialect: 'postgresql',
      dbCredentials: { url: db.url },
    })
  : defineConfig({
      schema: './src/db/schema.ts',
      out: './drizzle',
      dialect: 'sqlite',
      dbCredentials: { url: db.path },
    });
