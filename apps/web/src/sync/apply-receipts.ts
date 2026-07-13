import type {
  OperationReceipt,
  PushOperationsResponse,
} from '@kaoyan/contracts';
import type { SyncDatabase } from '../db/database';
import type { OperationRow, ReplicaRow } from '../db/types';
import {
  isActiveTimer,
  isTimerProjection,
  replicaKey,
} from '../db/types';
import { ProtocolError } from './errors';
import { projectEntity, projectTimer } from './projector';

function validReceipt(
  receipt: OperationReceipt,
): receipt is Exclude<OperationReceipt, { operationId: null }> {
  return receipt.operationId !== null;
}

async function activeForReplica(
  database: SyncDatabase,
  row: OperationRow,
): Promise<OperationRow[]> {
  return database.operations
    .where('[userId+entityType+entityId]')
    .equals([row.userId, row.entityType, row.entityId])
    .filter(
      (operation) =>
        operation.state === 'pending' || operation.state === 'acknowledged',
    )
    .sortBy('sequence');
}

async function reproject(
  database: SyncDatabase,
  operation: OperationRow,
): Promise<void> {
  const key = replicaKey(
    operation.userId,
    operation.entityType,
    operation.entityId,
  );
  const existing = await database.replicas.get(key);
  if (!existing) throw new Error('Operation replica is missing');
  const active = await activeForReplica(database, operation);
  const projectedValue = operation.entityType === 'activeTimer'
    ? projectTimer(
        isActiveTimer(existing.serverValue) ? existing.serverValue : null,
        active,
      )
    : projectEntity(existing.serverValue, active);
  const next: ReplicaRow = {
    ...existing,
    projectedValue,
    pendingOperationIds: active.map((row) => row.operationId),
  };
  await database.replicas.put(next);
  if (operation.entityType === 'activeTimer') {
    const cache = await database.timerCache.get(operation.userId);
    await database.timerCache.put({
      userId: operation.userId,
      serverTimer: cache?.serverTimer ?? null,
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

export async function applyPushReceipts(
  database: SyncDatabase,
  userId: string,
  pushed: readonly OperationRow[],
  response: PushOperationsResponse,
  now: string,
): Promise<string[]> {
  if (response.receipts.length !== pushed.length ||
      response.receipts.some((receipt) => !validReceipt(receipt)))
    throw new ProtocolError('Push returned malformed operation receipts');
  const byId = new Map(pushed.map((row) => [row.operationId, row]));
  const seen = new Set<string>();
  for (const receipt of response.receipts) {
    if (!validReceipt(receipt) || !byId.has(receipt.operationId) ||
        seen.has(receipt.operationId))
      throw new ProtocolError('Push receipts did not match the submitted batch');
    seen.add(receipt.operationId);
  }

  const conflictIds: string[] = [];
  await database.transaction(
    'rw',
    [
      database.operations,
      database.replicas,
      database.metadata,
      database.syncIssues,
      database.timerCache,
    ],
    async () => {
      for (const receipt of response.receipts) {
        if (!validReceipt(receipt)) throw new ProtocolError();
        const row = byId.get(receipt.operationId);
        if (!row || row.sequence === undefined) throw new ProtocolError();
        if (receipt.status === 'applied' || receipt.status === 'duplicate') {
          await database.operations.update(row.sequence, {
            state: 'acknowledged', receipt, lastError: null,
          });
        } else if (receipt.status === 'conflict') {
          conflictIds.push(receipt.conflictId);
          await database.operations.update(row.sequence, {
            state: 'conflict', receipt, conflictId: receipt.conflictId,
            lastError: null,
          });
        } else {
          await database.operations.update(row.sequence, {
            state: 'rejected', receipt,
            lastError: {
              code: receipt.errorCode,
              message: receipt.errorMessage,
            },
          });
          await database.syncIssues.put({
            operationId: row.operationId,
            userId,
            errorCode: receipt.errorCode,
            errorMessage: receipt.errorMessage,
            operation: row.operation,
            createdAt: now,
          });
        }
        await reproject(database, { ...row,
          state:
            receipt.status === 'applied' || receipt.status === 'duplicate'
              ? 'acknowledged'
              : receipt.status,
          receipt,
        });
      }
      const metadata = await database.getOrCreateMetadata(userId);
      const pendingCount = await database.countPendingOperations(userId);
      await database.metadata.put({
        ...metadata,
        latestKnownServerCursor: response.latestCursor,
        pendingCount,
      });
    },
  );
  return conflictIds;
}
