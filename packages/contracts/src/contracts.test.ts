import { describe, expect, it } from 'vitest';

import {
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  RenameDeviceRequestSchema,
  CurrentSessionSchema,
  DeviceIdParamsSchema,
  DeviceListResponseSchema,
  SuccessResponseSchema,
  ActiveTimerSchema,
  FocusSessionSchema,
  PauseTimerRequestSchema,
  StartTimerRequestSchema,
  TimerFinalizationResponseSchema,
  EntityVersionSchema,
  OperationReceiptSchema,
  ConflictSchema,
  ConflictAlreadyResolvedErrorSchema,
  ConflictResolutionTargetExistsErrorSchema,
  InvalidConflictResolutionErrorSchema,
  ResolvedConflictResultSchema,
  SyncChangeSchema,
  SyncOperationSchema,
  UserDataExportSchema,
} from './index';

const entityId = '018f556e-5bbb-7850-8117-41a14e88b577';
const operationId = '019f556e-5bbb-7850-8117-41a14e88b577';
const timestamp = '2026-07-12T08:30:00.000Z';

describe('authentication contracts', () => {
  it('validates login and preserves password whitespace', () => {
    expect(
      LoginRequestSchema.parse({
        username: '  learner  ',
        password: 'long password  ',
      }),
    ).toEqual({ username: 'learner', password: 'long password  ' });
  });

  it('requires matching password confirmation', () => {
    expect(() =>
      ChangePasswordRequestSchema.parse({
        currentPassword: 'current password',
        newPassword: 'new password long',
        confirmPassword: 'different password',
      }),
    ).toThrow();
  });

  it('rejects empty device names', () => {
    expect(() => RenameDeviceRequestSchema.parse({ name: '   ' })).toThrow();
  });

  it('validates authentication and device route responses', () => {
    const session = {
      user: { id: entityId, username: 'learner' },
      deviceId: operationId,
      deviceName: 'Chrome · Windows',
      expiresAt: timestamp,
    };
    expect(CurrentSessionSchema.parse(session)).toEqual(session);
    expect(DeviceListResponseSchema.parse({ devices: [] })).toEqual({
      devices: [],
    });
    expect(SuccessResponseSchema.parse({ ok: true })).toEqual({ ok: true });
  });

  it('requires UUID device route parameters', () => {
    expect(DeviceIdParamsSchema.parse({ deviceId: entityId })).toEqual({
      deviceId: entityId,
    });
    expect(() =>
      DeviceIdParamsSchema.parse({ deviceId: 'not-a-uuid' }),
    ).toThrow();
  });
});

describe('UserDataExportSchema', () => {
  it('validates the versioned, strict, user-readable export envelope', () => {
    const value = {
      exportVersion: 1,
      exportedAt: timestamp,
      account: { id: entityId, username: 'learner' },
      tasks: [],
      dailyTasks: [],
      focusSessions: [],
      settings: null,
      activeTimer: null,
      devices: [
        {
          deviceId: operationId,
          deviceName: 'Chrome · Windows',
          browser: 'Chrome',
          operatingSystem: 'Windows',
          createdAt: timestamp,
          lastActiveAt: timestamp,
          current: true,
          revokedAt: null,
        },
      ],
      conflicts: [],
    };

    expect(UserDataExportSchema.parse(value)).toEqual(value);
    expect(() =>
      UserDataExportSchema.parse({
        ...value,
        devices: [{ ...value.devices[0], tokenHash: 'secret' }],
      }),
    ).toThrow();
    expect(() =>
      UserDataExportSchema.parse({ ...value, exportVersion: 2 }),
    ).toThrow();
  });
});

describe('EntityVersionSchema', () => {
  it('accepts a versioned entity with an optional deletion timestamp', () => {
    expect(
      EntityVersionSchema.parse({
        id: entityId,
        version: 1,
        updatedAt: timestamp,
        deletedAt: null,
      }),
    ).toEqual({
      id: entityId,
      version: 1,
      updatedAt: timestamp,
      deletedAt: null,
    });
  });

  it('rejects non-positive versions and invalid timestamps', () => {
    expect(() =>
      EntityVersionSchema.parse({
        id: entityId,
        version: 0,
        updatedAt: 'today',
        deletedAt: null,
      }),
    ).toThrow();
  });
});

describe('SyncOperationSchema', () => {
  it('accepts an idempotent offline task operation', () => {
    const operation = SyncOperationSchema.parse({
      operationId,
      entityType: 'task',
      entityId,
      operationType: 'update',
      baseVersion: 2,
      payload: { title: '高等数学错题复盘' },
      createdAt: timestamp,
    });

    expect(operation.operationId).toBe(operationId);
    expect(operation.baseVersion).toBe(2);
  });

  it('rejects an operation without a base version', () => {
    expect(() =>
      SyncOperationSchema.parse({
        operationId,
        entityType: 'task',
        entityId,
        operationType: 'update',
        payload: {},
        createdAt: timestamp,
      }),
    ).toThrow();
  });

  it('rejects mutation types that violate entity synchronization rules', () => {
    expect(() =>
      SyncOperationSchema.parse({
        operationId,
        entityType: 'focusSession',
        entityId,
        operationType: 'update',
        baseVersion: 1,
        payload: {},
        createdAt: timestamp,
      }),
    ).toThrow();

    expect(() =>
      SyncOperationSchema.parse({
        operationId,
        entityType: 'settings',
        entityId,
        operationType: 'timerStart',
        baseVersion: 1,
        payload: {},
        createdAt: timestamp,
      }),
    ).toThrow();
  });

  it('rejects payloads that do not match their operation', () => {
    expect(() =>
      SyncOperationSchema.parse({
        operationId,
        entityType: 'task',
        entityId,
        operationType: 'delete',
        baseVersion: 2,
        payload: { title: '字段注入' },
        createdAt: timestamp,
      }),
    ).toThrow();

    expect(() =>
      SyncOperationSchema.parse({
        operationId,
        entityType: 'focusSession',
        entityId,
        operationType: 'create',
        baseVersion: 0,
        payload: {},
        createdAt: timestamp,
      }),
    ).toThrow();

    expect(() =>
      SyncOperationSchema.parse({
        operationId,
        entityType: 'activeTimer',
        entityId,
        operationType: 'timerStart',
        baseVersion: 0,
        payload: {
          dailyTaskId: entityId,
          phase: 'focus',
          plannedSeconds: 0,
        },
        createdAt: timestamp,
      }),
    ).toThrow();

    expect(() =>
      SyncOperationSchema.parse({
        operationId,
        entityType: 'settings',
        entityId,
        operationType: 'update',
        baseVersion: 1,
        payload: { unexpected: true },
        createdAt: timestamp,
      }),
    ).toThrow();
  });
});

describe('synchronization payload schemas', () => {
  it('validates an incremental change cursor', () => {
    expect(
      SyncChangeSchema.parse({
        cursor: 42,
        entityType: 'task',
        entityId,
        version: 3,
        changeType: 'upsert',
        payload: { title: '线性代数' },
        changedAt: timestamp,
      }).cursor,
    ).toBe(42);
  });

  it('validates a paused global timer', () => {
    expect(
      ActiveTimerSchema.parse({
        id: entityId,
        version: 4,
        updatedAt: timestamp,
        deletedAt: null,
        dailyTaskId: '029f556e-5bbb-7850-8117-41a14e88b577',
        taskTitle: '线性代数',
        subject: '数学',
        phase: 'focus',
        status: 'paused',
        plannedSeconds: 1500,
        startedAt: '2026-07-12T08:00:00.000Z',
        targetEndAt: '2026-07-12T08:25:00.000Z',
        pausedAt: '2026-07-12T08:10:00.000Z',
        accumulatedPausedSeconds: 0,
        interruptionReason: '喝水',
      }).status,
    ).toBe('paused');
  });

  it('rejects inconsistent change, timer, and receipt states', () => {
    expect(() =>
      SyncChangeSchema.parse({
        cursor: 43,
        entityType: 'task',
        entityId,
        version: 4,
        changeType: 'delete',
        payload: { title: '不应随删除返回' },
        changedAt: timestamp,
      }),
    ).toThrow();

    expect(() =>
      ActiveTimerSchema.parse({
        id: entityId,
        version: 5,
        updatedAt: timestamp,
        deletedAt: null,
        dailyTaskId: '029f556e-5bbb-7850-8117-41a14e88b577',
        taskTitle: '线性代数',
        subject: '数学',
        phase: 'focus',
        status: 'running',
        plannedSeconds: 1500,
        startedAt: '2026-07-12T08:00:00.000Z',
        targetEndAt: '2026-07-12T08:25:00.000Z',
        pausedAt: '2026-07-12T08:10:00.000Z',
        accumulatedPausedSeconds: 0,
        interruptionReason: null,
      }),
    ).toThrow();

    expect(() =>
      OperationReceiptSchema.parse({
        operationId,
        status: 'applied',
        entityVersion: 3,
        conflictId: entityId,
      }),
    ).toThrow();
  });

  it('strictly validates Task 6 timer requests and finalized sessions', () => {
    expect(
      StartTimerRequestSchema.parse({
        id: entityId,
        dailyTaskId: '029f556e-5bbb-7850-8117-41a14e88b577',
        dailyTaskVersion: 3,
        phase: 'focus',
        plannedSeconds: 10_800,
      }).dailyTaskVersion,
    ).toBe(3);
    expect(PauseTimerRequestSchema.parse({ expectedVersion: 1, reason: '  喝水  ' }).reason).toBe('喝水');
    expect(() =>
      StartTimerRequestSchema.parse({
        id: entityId,
        dailyTaskId: entityId,
        dailyTaskVersion: 1,
        phase: 'focus',
        plannedSeconds: 10_801,
      }),
    ).toThrow();
    const session = FocusSessionSchema.parse({
      id: entityId,
      dailyTaskId: '029f556e-5bbb-7850-8117-41a14e88b577',
      taskTitle: '线性代数',
      subject: '数学',
      phase: 'focus',
      plannedSeconds: 60,
      effectiveSeconds: 60,
      startedAt: timestamp,
      endedAt: timestamp,
      result: 'completed',
      interruptionReason: null,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    });
    expect(
      TimerFinalizationResponseSchema.parse({
        outcome: 'finalized',
        focusSession: session,
        serverTime: timestamp,
      }).focusSession.id,
    ).toBe(entityId);
    expect(() => FocusSessionSchema.parse({ ...session, version: 2 })).toThrow();
  });

  it('strictly validates Task 5 receipts and conflicts', () => {
    expect(
      OperationReceiptSchema.parse({
        operationId,
        status: 'applied',
        entityVersion: 1,
        conflictId: null,
        errorCode: null,
        errorMessage: null,
      }).status,
    ).toBe('applied');
    expect(() =>
      OperationReceiptSchema.parse({
        operationId,
        status: 'rejected',
        entityVersion: null,
        conflictId: null,
        errorCode: null,
        errorMessage: null,
      }),
    ).toThrow();
    expect(
      ConflictSchema.parse({
        id: entityId,
        entityType: 'task',
        entityId,
        conflictType: 'delete_modify',
        localOperationId: operationId,
        baseVersion: 1,
        serverVersion: 2,
        localPayload: {},
        serverPayload: { id: entityId },
        status: 'open',
        resolution: null,
        resolutionResult: null,
        createdAt: timestamp,
        resolvedAt: null,
      }).status,
    ).toBe('open');
  });

  it('strictly validates resolved conflict results and domain errors', () => {
    const result = {
      resolutionRequest: {
        resolution: 'copyAsNew',
        newEntityId: '028f556e-5bbb-7850-8117-41a14e88b577',
      },
      affectedVersions: {
        [entityId]: 3,
        '028f556e-5bbb-7850-8117-41a14e88b577': 1,
      },
    };
    expect(ResolvedConflictResultSchema.parse(result)).toEqual(result);
    expect(
      InvalidConflictResolutionErrorSchema.parse({
        code: 'INVALID_CONFLICT_RESOLUTION',
        message: 'Resolution is not valid for this conflict type',
        conflictType: 'complete_restore',
        resolution: 'keepServer',
      }).code,
    ).toBe('INVALID_CONFLICT_RESOLUTION');
    expect(
      ConflictAlreadyResolvedErrorSchema.parse({
        code: 'CONFLICT_ALREADY_RESOLVED',
        message: 'Conflict was already resolved differently',
        resolution: 'copyAsNew',
        resolutionResult: result,
      }).resolutionResult,
    ).toEqual(result);
    expect(() =>
      ResolvedConflictResultSchema.parse({
        ...result,
        unexpected: true,
      }),
    ).toThrow();
  });

  it('supports strict legacy resolution results and target collision errors', () => {
    const legacy = {
      legacy: true,
      resolution: 'copyAsNew',
      affectedVersions: {},
    } as const;
    expect(ResolvedConflictResultSchema.parse(legacy)).toEqual(legacy);
    expect(
      ConflictAlreadyResolvedErrorSchema.parse({
        code: 'CONFLICT_ALREADY_RESOLVED',
        message: 'Conflict was already resolved differently',
        resolution: 'copyAsNew',
        resolutionResult: legacy,
      }).resolutionResult,
    ).toEqual(legacy);
    expect(
      ConflictResolutionTargetExistsErrorSchema.parse({
        code: 'CONFLICT_RESOLUTION_TARGET_EXISTS',
        message: 'Conflict resolution target already exists',
        entityId,
      }).entityId,
    ).toBe(entityId);
    expect(() =>
      ResolvedConflictResultSchema.parse({ ...legacy, unexpected: true }),
    ).toThrow();
  });
});
