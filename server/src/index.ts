import { createApp } from './app';
import { loadConfigOrExit } from './config';
import { createDb } from './db/client';

const config = loadConfigOrExit();
const db = createDb(config.db);

export default {
  port: config.port,
  fetch: createApp({ db }).fetch,
};
