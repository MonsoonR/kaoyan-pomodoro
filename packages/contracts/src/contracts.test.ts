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
  EntityVersionSchema,
  OperationReceiptSchema,
  SyncChangeSchema,
  SyncOperationSchema,
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
        phase: 'focus',
        status: 'paused',
        plannedSeconds: 1500,
        startedAt: '2026-07-12T08:00:00.000Z',
        targetEndAt: '2026-07-12T08:25:00.000Z',
        pausedAt: '2026-07-12T08:10:00.000Z',
        accumulatedPausedSeconds: 0,
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
        phase: 'focus',
        status: 'running',
        plannedSeconds: 1500,
        startedAt: '2026-07-12T08:00:00.000Z',
        targetEndAt: '2026-07-12T08:25:00.000Z',
        pausedAt: '2026-07-12T08:10:00.000Z',
        accumulatedPausedSeconds: 0,
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
});
