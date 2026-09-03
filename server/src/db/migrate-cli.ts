import { loadConfigOrExit } from '../config';
import { createDb } from './client';
import { migrateDb } from './migrate';

// `bun run db:migrate`. Migrations run here, never at server boot (A-15 cold-start budget).
const config = loadConfigOrExit();
const db = createDb(config.db);
try {
  await migrateDb(db);
  console.log(`cypherkey: ${db.dialect} schema is up to date.`);
} finally {
  await db.close();
}
