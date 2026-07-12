import { pathToFileURL } from 'node:url';

import { createApp } from './app';
import { readEnv } from './config/env';
import { openDatabase } from './db/client';
import { migrateDatabase } from './db/migrate';

export async function startServer() {
  const env = readEnv();
  const database = openDatabase(env.DATABASE_PATH);
  migrateDatabase(database.db);
  const app = await createApp({
    database,
    appOrigin: env.APP_ORIGIN,
    trustProxy: env.TRUST_PROXY_HOPS,
  });
  app.addHook('onClose', async () => database.close());
  await app.listen({ host: env.HOST, port: env.PORT });
  return app;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) await startServer();
