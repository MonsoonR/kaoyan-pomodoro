import { fileURLToPath, pathToFileURL } from 'node:url';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { openDatabase, type AppDatabase } from './client';
import { resolveDatabaseSource } from './database-source';

export const defaultMigrationsFolder = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
);

export function migrateDatabase(
  db: AppDatabase,
  migrationsFolder = defaultMigrationsFolder,
) {
  migrate(db, { migrationsFolder });

  const result = db.$client.prepare('PRAGMA integrity_check').get() as
    | { integrity_check?: string }
    | undefined;
  if (result?.integrity_check !== 'ok') {
    throw new Error(`SQLite integrity check failed: ${String(result?.integrity_check)}`);
  }
}

function isDirectExecution() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  const source = process.env.DATABASE_PATH;
  if (!source) {
    throw new Error('DATABASE_PATH is required to run database migrations');
  }

  const connection = openDatabase(resolveDatabaseSource(source));
  try {
    migrateDatabase(connection.db);
  } finally {
    connection.close();
  }
}
