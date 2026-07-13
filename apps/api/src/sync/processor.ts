import { randomUUID } from 'node:crypto';
import {
  OperationReceiptSchema,
  type OperationReceipt,
  type SyncOperation,
} from '@kaoyan/contracts';
import type Database from 'better-sqlite3';
import { createDailyTaskService } from '../services/daily-tasks';
import { StaleVersionError } from '../services/errors';
import { createSettingsService } from '../services/settings';
import { createTaskService } from '../services/tasks';

interface ProcessorDependencies {
  sqlite: Database.Database;
  now: () => Date;
  generateId?: () => string;
  writeReceipt?: (sqlite: Database.Database, values: ReceiptValues) => void;
}
interface ReceiptValues {
  operation: SyncOperation;
  userId: string;
  deviceId: string;
  status: 'applied' | 'conflict' | 'rejected';
  entityVersion: number | null;
  conflictId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  processedAt: number;
}
interface StoredReceipt {
  status: 'applied' | 'conflict' | 'rejected';
  entity_version: number | null;
  conflict_id: string | null;
  error_code: string | null;
  error_message: string | null;
}

const defaultWriteReceipt = (
  sqlite: Database.Database,
  value: ReceiptValues,
) => {
  sqlite
    .prepare(
      `
        INSERT INTO sync_operations (
          operation_id, user_id, device_id, entity_type, entity_id,
          operation_type, base_version, payload, status, entity_version,
          conflict_id, error_code, error_message, created_at, processed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      value.operation.operationId,
      value.userId,
      value.deviceId,
      value.operation.entityType,
      value.operation.entityId,
      value.operation.operationType,
      value.operation.baseVersion,
      JSON.stringify(value.operation.payload),
      value.status,
      value.entityVersion,
      value.conflictId,
      value.errorCode,
      value.errorMessage,
      new Date(value.operation.createdAt).getTime(),
      value.processedAt,
    );
};

export function createSyncProcessor(deps: ProcessorDependencies) {
  const tasks = createTaskService(deps);
  const daily = createDailyTaskService(deps);
  const settings = createSettingsService(deps);
  const writeReceipt = deps.writeReceipt ?? defaultWriteReceipt;
  const generateId = deps.generateId ?? randomUUID;

  const rejected = (
    operation: SyncOperation,
    entityVersion: number | null,
    errorCode: string,
    errorMessage: string,
  ) => ({
    operation,
    status: 'rejected' as const,
    entityVersion,
    conflictId: null,
    errorCode,
    errorMessage,
  });

  const createConflict = (
    operation: SyncOperation,
    userId: string,
    deviceId: string,
    conflictType: 'delete_modify' | 'complete_restore' | 'archive_add_today',
    serverVersion: number,
    serverPayload: Record<string, unknown>,
  ) => {
    const conflictId = generateId();
    deps.sqlite
      .prepare(
        `
          INSERT INTO conflicts (
            id, user_id, device_id, entity_type, entity_id, conflict_type,
            local_operation_id, base_version, server_version, local_payload,
            server_payload, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
        `,
      )
      .run(
        conflictId,
        userId,
        deviceId,
        operation.entityType,
        operation.entityId,
        conflictType,
        operation.operationId,
        operation.baseVersion,
        serverVersion,
        JSON.stringify(operation.payload),
        JSON.stringify(serverPayload),
        deps.now().getTime(),
      );
    return {
      operation,
      status: 'conflict' as const,
      entityVersion: serverVersion,
      conflictId,
      errorCode: null,
      errorMessage: null,
    };
  };

  const dispatch = (
    operation: SyncOperation,
    userId: string,
    deviceId: string,
  ) => {
    if (
      operation.entityType === 'focusSession' ||
      operation.entityType === 'activeTimer'
    )
      return rejected(
        operation,
        null,
        'OPERATION_NOT_SUPPORTED',
        'Operation is not supported yet',
      );

    if (operation.entityType === 'task') {
      const current = tasks.getAny(userId, operation.entityId);
      if (operation.operationType === 'create') {
        if (operation.baseVersion !== 0)
          return rejected(
            operation,
            current?.version ?? null,
            'INVALID_BASE_VERSION',
            'Create requires baseVersion 0',
          );
        if (current)
          return rejected(
            operation,
            current.version,
            'ENTITY_ALREADY_EXISTS',
            'Entity already exists',
          );
        const entity = tasks.create(userId, {
          id: operation.entityId,
          ...operation.payload,
        });
        return applied(operation, entity.version);
      }
      if (!current)
        return rejected(
          operation,
          null,
          'ENTITY_NOT_FOUND',
          'Entity not found',
        );
      if (current.deletedAt) {
        if (operation.operationType === 'delete')
          return applied(operation, current.version);
        return rejected(
          operation,
          current.version,
          'ENTITY_DELETED',
          'Entity is deleted',
        );
      }
      if (operation.operationType === 'update') {
        try {
          return applied(
            operation,
            tasks.update(userId, operation.entityId, {
              expectedVersion: operation.baseVersion,
              ...operation.payload,
            }).version,
          );
        } catch (error) {
          if (!(error instanceof StaleVersionError)) throw error;
          return applied(
            operation,
            tasks.update(userId, operation.entityId, {
              expectedVersion: error.currentVersion,
              ...operation.payload,
            }).version,
          );
        }
      }
      if (operation.operationType === 'delete') {
        if (operation.baseVersion !== current.version)
          return createConflict(
            operation,
            userId,
            deviceId,
            'delete_modify',
            current.version,
            current,
          );
        return applied(
          operation,
          tasks.delete(userId, operation.entityId, current.version).version,
        );
      }
      const desired = operation.operationType === 'archive';
      if (current.archived === desired)
        return applied(operation, current.version);
      if (operation.baseVersion !== current.version)
        return rejected(
          operation,
          current.version,
          'STALE_ARCHIVE_STATE',
          'Archive state is stale',
        );
      return applied(
        operation,
        tasks.setArchived(userId, operation.entityId, current.version, desired)
          .version,
      );
    }

    if (operation.entityType === 'dailyTask') {
      if (operation.operationType === 'addToToday') {
        if (operation.baseVersion !== 0)
          return rejected(
            operation,
            null,
            'INVALID_BASE_VERSION',
            'Create requires baseVersion 0',
          );
        if (daily.getAny(userId, operation.entityId))
          return rejected(
            operation,
            null,
            'ENTITY_ALREADY_EXISTS',
            'Entity already exists',
          );
        const source = tasks.getAny(userId, operation.payload.sourceTaskId);
        if (!source || source.deletedAt)
          return rejected(
            operation,
            source?.version ?? null,
            'SOURCE_TASK_DELETED',
            'Source task is deleted',
          );
        if (source.archived) {
          if (source.version !== operation.payload.sourceTaskVersion)
            return createConflict(
              operation,
              userId,
              deviceId,
              'archive_add_today',
              source.version,
              source,
            );
          return rejected(
            operation,
            source.version,
            'SOURCE_TASK_ARCHIVED',
            'Source task is archived',
          );
        }
        return applied(
          operation,
          daily.addFromTask(userId, source.id, {
            id: operation.entityId,
            date: operation.payload.date,
            sortOrder: operation.payload.sortOrder,
          }).version,
        );
      }
      const current = daily.getAny(userId, operation.entityId);
      if (operation.operationType === 'create') {
        if (operation.baseVersion !== 0)
          return rejected(
            operation,
            current?.version ?? null,
            'INVALID_BASE_VERSION',
            'Create requires baseVersion 0',
          );
        if (current)
          return rejected(
            operation,
            current.version,
            'ENTITY_ALREADY_EXISTS',
            'Entity already exists',
          );
        if (operation.payload.sourceTaskId !== null)
          return rejected(
            operation,
            null,
            'SOURCE_TASK_NOT_ALLOWED',
            'Temporary task sourceTaskId must be null',
          );
        const entity = daily.createTemporary(userId, {
          id: operation.entityId,
          ...operation.payload,
        });
        return applied(operation, entity.version);
      }
      if (!current)
        return rejected(
          operation,
          null,
          'ENTITY_NOT_FOUND',
          'Entity not found',
        );
      if (current.deletedAt) {
        if (operation.operationType === 'delete')
          return applied(operation, current.version);
        return rejected(
          operation,
          current.version,
          'ENTITY_DELETED',
          'Entity is deleted',
        );
      }
      if (operation.operationType === 'update') {
        try {
          return applied(
            operation,
            daily.update(userId, operation.entityId, {
              expectedVersion: operation.baseVersion,
              ...operation.payload,
            }).version,
          );
        } catch (error) {
          if (!(error instanceof StaleVersionError)) throw error;
          return applied(
            operation,
            daily.update(userId, operation.entityId, {
              expectedVersion: error.currentVersion,
              ...operation.payload,
            }).version,
          );
        }
      }
      if (operation.operationType === 'delete') {
        if (operation.baseVersion !== current.version)
          return createConflict(
            operation,
            userId,
            deviceId,
            'delete_modify',
            current.version,
            current,
          );
        return applied(
          operation,
          daily.delete(userId, operation.entityId, current.version).version,
        );
      }
      const complete = operation.operationType === 'complete';
      const alreadyDesired = complete
        ? current.status === 'completed'
        : current.status === 'pending';
      if (alreadyDesired) return applied(operation, current.version);
      if (operation.baseVersion !== current.version)
        return createConflict(
          operation,
          userId,
          deviceId,
          'complete_restore',
          current.version,
          current,
        );
      return applied(
        operation,
        daily.setCompleted(
          userId,
          operation.entityId,
          current.version,
          complete,
        ).version,
      );
    }

    try {
      return applied(
        operation,
        settings.update(userId, {
          expectedVersion: operation.baseVersion,
          ...operation.payload,
        }).version,
      );
    } catch (error) {
      if (!(error instanceof StaleVersionError)) throw error;
      return applied(
        operation,
        settings.update(userId, {
          expectedVersion: error.currentVersion,
          ...operation.payload,
        }).version,
      );
    }
  };

  return {
    process(
      operation: SyncOperation,
      userId: string,
      deviceId: string,
    ): OperationReceipt {
      return deps.sqlite.transaction(() => {
        const existing = deps.sqlite
          .prepare(
            `SELECT status, entity_version, conflict_id, error_code, error_message FROM sync_operations WHERE operation_id = ? AND user_id = ?`,
          )
          .get(operation.operationId, userId) as StoredReceipt | undefined;
        if (existing) return stored(operation.operationId, existing);
        const result = dispatch(operation, userId, deviceId);
        writeReceipt(deps.sqlite, {
          ...result,
          userId,
          deviceId,
          processedAt: deps.now().getTime(),
        });
        return OperationReceiptSchema.parse({
          operationId: operation.operationId,
          status: result.status,
          entityVersion: result.entityVersion,
          conflictId: result.conflictId,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        });
      })();
    },
  };
}

function applied(operation: SyncOperation, entityVersion: number) {
  return {
    operation,
    status: 'applied' as const,
    entityVersion,
    conflictId: null,
    errorCode: null,
    errorMessage: null,
  };
}
function stored(operationId: string, row: StoredReceipt): OperationReceipt {
  return OperationReceiptSchema.parse({
    operationId,
    status: row.status === 'applied' ? 'duplicate' : row.status,
    entityVersion: row.entity_version,
    conflictId: row.conflict_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  });
}
