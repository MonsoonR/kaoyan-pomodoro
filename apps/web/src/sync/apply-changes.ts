import {
  ActiveTimerSchema,
  DailyTaskSchema,
  FocusSessionSchema,
  SettingsSchema,
  SyncChangeSchema,
  TaskSchema,
  type PullChangesResponse,
  type SyncChange,
} from '@kaoyan/contracts';
import type { SyncDatabase } from '../db/database';
import type { OperationRow, ReplicaRow, ServerEntity } from '../db/types';
import { isActiveTimer, isTimerProjection, replicaKey } from '../db/types';
import { ProtocolError } from './errors';
import { projectEntity, projectTimer } from './projector';

function parseServerValue(change: SyncChange): ServerEntity | null {
  if (change.changeType === 'delete') return null;
  const schema = {
    task: TaskSchema,
    dailyTask: DailyTaskSchema,
    focusSession: FocusSessionSchema,
    activeTimer: ActiveTimerSchema,
    settings: SettingsSchema,
  }[change.entityType];
  try {
    const parsed = schema.parse(change.payload);
    if (parsed.id !== change.entityId || parsed.version !== change.version)
      throw new ProtocolError(
        `${change.entityType} payload identity did not match its change`,
      );
    return parsed;
  } catch {
    throw new ProtocolError(`Invalid ${change.entityType} change payload`);
  }
}

async function activeOperations(
  database: SyncDatabase,
  userId: string,
  change: SyncChange,
): Promise<OperationRow[]> {
  return database.operations
    .where('[userId+entityType+entityId]')
    .equals([userId, change.entityType, change.entityId])
    .filter(
      (row) => row.state === 'pending' || row.state === 'acknowledged',
    )
    .sortBy('sequence');
}

export async function applyPullPage(
  database: SyncDatabase,
  userId: string,
  rawPage: PullChangesResponse,
): Promise<void> {
  const metadata = await database.getOrCreateMetadata(userId);
  const changes = rawPage.changes.map((raw) => {
    try { return SyncChangeSchema.parse(raw); }
    catch { throw new ProtocolError('Invalid synchronization change'); }
  });
  let previousCursor = metadata.cursor;
  const parsed = changes.map((change) => {
    if (change.cursor <= previousCursor)
      throw new ProtocolError('Changes were not ordered by cursor');
    previousCursor = change.cursor;
    return { change, serverValue: parseServerValue(change) };
  });
  const expectedCursor = changes.at(-1)?.cursor ?? metadata.cursor;
  if (rawPage.nextCursor !== expectedCursor)
    throw new ProtocolError('Pull page nextCursor did not match its changes');

  await database.transaction(
    'rw',
    [database.replicas, database.operations, database.metadata, database.timerCache],
    async () => {
      for (const { change, serverValue } of parsed) {
        const matching = await database.operations
          .where('[userId+entityType+entityId]')
          .equals([userId, change.entityType, change.entityId])
          .filter((row) => row.state === 'acknowledged')
          .toArray();
        for (const row of matching) {
          const receiptVersion = row.receipt?.entityVersion;
          if (receiptVersion !== null && receiptVersion !== undefined &&
              receiptVersion <= change.version && row.sequence !== undefined)
            await database.operations.delete(row.sequence);
        }
        const active = await activeOperations(database, userId, change);
        const key = replicaKey(userId, change.entityType, change.entityId);
        const projectedValue = change.entityType === 'activeTimer'
          ? projectTimer(
              isActiveTimer(serverValue) ? serverValue : null,
              active,
            )
          : projectEntity(serverValue, active);
        const replica: ReplicaRow = {
          key,
          userId,
          entityType: change.entityType,
          entityId: change.entityId,
          serverValue,
          projectedValue,
          serverVersion: change.version,
          pendingOperationIds: active.map((row) => row.operationId),
          updatedLocallyAt: active.at(-1)?.enqueuedAt ?? null,
        };
        await database.replicas.put(replica);
        if (change.entityType === 'activeTimer') {
          const cache = await database.timerCache.get(userId);
          const serverTimer = isActiveTimer(serverValue)
            ? serverValue
            : null;
          await database.timerCache.put({
            userId,
            serverTimer,
            projectedTimer: isTimerProjection(projectedValue)
              ? projectedValue
              : null,
            serverTime: cache?.serverTime ?? null,
            receivedAt: cache?.receivedAt ?? null,
            clockOffsetMs: cache?.clockOffsetMs ?? null,
            clockUncertaintyMs: cache?.clockUncertaintyMs ?? null,
            pendingOperationIds: active.map((row) => row.operationId),
          });
        }
      }
      const current = await database.getOrCreateMetadata(userId);
      const pendingCount = await database.countPendingOperations(userId);
      await database.metadata.put({
        ...current,
        cursor: rawPage.nextCursor,
        pendingCount,
      });
    },
  );
}
