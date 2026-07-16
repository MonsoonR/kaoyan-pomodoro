import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { initializeAccount } from '../auth/account-service';
import { openDatabase } from '../db/client';
import { migrateDatabase } from '../db/migrate';
import { getAccountInitializationStatus } from './account';

describe('account initialization status', () => {
  it('reports only initialization state through a read-only database connection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kaoyan-account-status-'));
    const source = join(directory, 'test.sqlite');

    try {
      let connection = openDatabase(source);
      migrateDatabase(connection.db);
      connection.close();

      const databaseModifiedBefore = statSync(source).mtimeMs;
      expect(getAccountInitializationStatus(source)).toBe(false);
      expect(statSync(source).mtimeMs).toBe(databaseModifiedBefore);

      connection = openDatabase(source);
      await initializeAccount(connection.sqlite, {
        username: 'admin',
        password: 'correct horse battery staple',
        confirmPassword: 'correct horse battery staple',
      });
      connection.close();

      expect(getAccountInitializationStatus(source)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
