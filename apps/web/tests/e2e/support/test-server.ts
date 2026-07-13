import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../../../api/src/app';
import { initializeAccount } from '../../../../api/src/auth/account-service';
import { TEST_PASSWORD_OPTIONS } from '../../../../api/src/auth/password';
import { openDatabase } from '../../../../api/src/db/client';
import { migrateDatabase } from '../../../../api/src/db/migrate';

const directory = mkdtempSync(join(tmpdir(), 'kaoyan-timer-e2e-'));
const database = openDatabase(join(directory, 'test.sqlite'));
migrateDatabase(database.db);
await initializeAccount(database.sqlite, {
  username: 'learner',
  password: 'correct horse battery staple',
  confirmPassword: 'correct horse battery staple',
}, TEST_PASSWORD_OPTIONS);

const app = await createApp({
  database,
  appOrigin: process.env.KAOYAN_APP_ORIGIN ?? 'http://localhost:4173',
  passwordOptions: TEST_PASSWORD_OPTIONS,
  logger: false,
});
await app.listen({ host: '127.0.0.1', port: 4174 });

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  if (database.sqlite.open) database.close();
  rmSync(directory, { recursive: true, force: true });
}

process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
