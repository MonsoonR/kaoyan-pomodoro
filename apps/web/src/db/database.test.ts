import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncDatabase } from './database';
import type { SyncDatabase } from './database';
import { DATABASE_STORES } from './schema';
import { USER_A, USER_B } from '../test/fixtures';

describe('sync database', () => {
  let database: SyncDatabase | undefined;
  afterEach(async () => database?.deleteDatabaseForTests());

  it('starts with cursor zero for a new user', async () => {
    database = createSyncDatabase(`db-${crypto.randomUUID()}`);
    await database.open();
    expect(await database.getOrCreateMetadata(USER_A)).toMatchObject({
      cursor: 0,
    });
  });

  it('creates every table and declared index', async () => {
    database = createSyncDatabase(`db-${crypto.randomUUID()}`);
    await database.open();
    expect(database.tables.map((table) => table.name).sort()).toEqual(
      Object.keys(DATABASE_STORES).sort(),
    );
    expect(database.operations.schema.primKey.auto).toBe(true);
    expect(database.operations.schema.indexes.map((index) => index.name))
      .toContain('[userId+state+sequence]');
  });

  it('persists metadata across close and reopen', async () => {
    const name = `db-${crypto.randomUUID()}`;
    database = createSyncDatabase(name);
    await database.open();
    await database.metadata.put({
      ...(await database.getOrCreateMetadata(USER_A)), cursor: 17,
    });
    database.close();
    database = createSyncDatabase(name);
    await database.open();
    expect((await database.metadata.get(USER_A))?.cursor).toBe(17);
  });

  it('isolates metadata and active users', async () => {
    database = createSyncDatabase(`db-${crypto.randomUUID()}`);
    await database.open();
    await database.getOrCreateMetadata(USER_A);
    await database.setActiveUser(USER_B);
    expect((await database.metadata.get(USER_A))?.cursor).toBe(0);
    expect(await database.getActiveUserId()).toBe(USER_B);
  });

  it('deletes a test database explicitly', async () => {
    const name = `db-${crypto.randomUUID()}`;
    database = createSyncDatabase(name);
    await database.open();
    await database.getOrCreateMetadata(USER_A);
    await database.deleteDatabaseForTests();
    database = createSyncDatabase(name);
    await database.open();
    expect(await database.metadata.count()).toBe(0);
  });

  it('never reads the legacy localStorage state', async () => {
    const getItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem });
    database = createSyncDatabase(`db-${crypto.randomUUID()}`);
    await database.open();
    await database.getOrCreateMetadata(USER_A);
    expect(getItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('refuses to clear a replica when operations must be retained', async () => {
    database = createSyncDatabase(`db-${crypto.randomUUID()}`);
    await database.open();
    await database.operations.add({
      operationId: '00000000-0000-4000-8000-000000000080',
      userId: USER_A,
      operation: {
        operationId: '00000000-0000-4000-8000-000000000080',
        entityType: 'task', entityId: '00000000-0000-4000-8000-000000000081',
        operationType: 'delete', baseVersion: 1, payload: {},
        createdAt: '2026-07-13T04:00:00.000Z',
      },
      entityType: 'task', entityId: '00000000-0000-4000-8000-000000000081',
      state: 'pending', attempts: 0,
      enqueuedAt: '2026-07-13T04:00:00.000Z', lastAttemptAt: null,
      receipt: null, lastError: null, conflictId: null, projectionSeed: null,
    });
    await expect(database.clearUserReplica(USER_A)).rejects
      .toThrow('retained operations');
    expect(await database.countPendingOperations(USER_A)).toBe(1);
  });
});
