import Database from 'better-sqlite3';
import {
  type BetterSQLite3Database,
  drizzle,
} from 'drizzle-orm/better-sqlite3';

import { schema } from './schema';

export interface DatabaseConnection {
  db: BetterSQLite3Database<typeof schema> & { $client: Database.Database };
  sqlite: Database.Database;
  close(): void;
}

export function openDatabase(source: string): DatabaseConnection {
  const sqlite = new Database(source);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  if (source !== ':memory:') {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
  }

  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
    close() {
      sqlite.close();
    },
  };
}

export type AppDatabase = ReturnType<typeof openDatabase>['db'];
