import Dexie, { type Table } from 'dexie';
import { createMetadata } from './metadata';
import {
  DATABASE_NAME,
  DATABASE_STORES,
  DATABASE_VERSION,
} from './schema';
import type {
  ConflictRow,
  MetadataRow,
  OperationRow,
  ReplicaRow,
  SyncIssueRow,
  TimerCacheRow,
} from './types';

export class SyncDatabase extends Dexie {
  replicas!: Table<ReplicaRow, string>;
  operations!: Table<OperationRow, number>;
  metadata!: Table<MetadataRow, string>;
  conflicts!: Table<ConflictRow, string>;
  timerCache!: Table<TimerCacheRow, string>;
  syncIssues!: Table<SyncIssueRow, number>;

  constructor(name: string = DATABASE_NAME) {
    super(name, { autoOpen: false });
    this.version(DATABASE_VERSION).stores(DATABASE_STORES);
  }

  async getOrCreateMetadata(userId: string): Promise<MetadataRow> {
    const existing = await this.metadata.get(userId);
    if (existing) return existing;
    const created = createMetadata(userId);
    await this.metadata.add(created);
    return created;
  }

  async setActiveUser(userId: string): Promise<MetadataRow> {
    return this.transaction('rw', this.metadata, async () => {
      const rows = await this.metadata.toArray();
      await Promise.all(
        rows
          .filter((row) => row.activeUserId !== null)
          .map((row) =>
            this.metadata.update(row.userId, { activeUserId: null }),
          ),
      );
      const row = (await this.metadata.get(userId)) ?? createMetadata(userId);
      const active = {
        ...row,
        activeUserId: userId,
        authState: 'authenticated' as const,
      };
      await this.metadata.put(active);
      return active;
    });
  }

  async getActiveUserId(): Promise<string | null> {
    return (await this.metadata.where('activeUserId').notEqual('').first())
      ?.activeUserId ?? null;
  }

  async clearUserReplica(userId: string): Promise<void> {
    const retainedOperationCount = await this.operations
      .where('userId')
      .equals(userId)
      .filter(
        (row) => row.state === 'pending' || row.state === 'acknowledged',
      )
      .count();
    if (retainedOperationCount > 0)
      throw new Error('Cannot clear a user replica with retained operations');
    await this.transaction(
      'rw',
      [
        this.replicas,
        this.metadata,
        this.conflicts,
        this.timerCache,
      ],
      async () => {
        await this.replicas.where('userId').equals(userId).delete();
        await this.conflicts.where('userId').equals(userId).delete();
        await this.timerCache.delete(userId);
        const metadata = await this.metadata.get(userId);
        if (metadata) {
          await this.metadata.put({
            ...createMetadata(userId),
            activeUserId: metadata.activeUserId,
            authState: metadata.authState,
          });
        }
      },
    );
  }

  async countPendingOperations(userId: string): Promise<number> {
    return this.operations
      .where('[userId+state+sequence]')
      .between(
        [userId, 'pending', Dexie.minKey],
        [userId, 'pending', Dexie.maxKey],
      )
      .count();
  }

  async deleteDatabaseForTests(): Promise<void> {
    this.close();
    await Dexie.delete(this.name);
  }
}

export function createSyncDatabase(name: string = DATABASE_NAME): SyncDatabase {
  return new SyncDatabase(name);
}
