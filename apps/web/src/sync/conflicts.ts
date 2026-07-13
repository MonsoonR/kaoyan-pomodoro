import type { Conflict } from '@kaoyan/contracts';
import type { SyncDatabase } from '../db/database';
import { conflictKey } from '../db/types';

export async function cacheConflicts(
  database: SyncDatabase,
  userId: string,
  conflicts: readonly Conflict[],
  fetchedAt: string,
): Promise<void> {
  await database.transaction('rw', database.conflicts, async () => {
    await database.conflicts.bulkPut(
      conflicts.map((conflict) => ({
        key: conflictKey(userId, conflict.id),
        id: conflict.id,
        userId,
        status: conflict.status,
        conflictType: conflict.conflictType,
        entityType: conflict.entityType,
        entityId: conflict.entityId,
        value: conflict,
        fetchedAt,
      })),
    );
  });
}
