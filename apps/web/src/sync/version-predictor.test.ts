import { SyncOperationSchema, type SyncOperation } from '@kaoyan/contracts';
import { describe, expect, it } from 'vitest';
import {
  DAILY_ID,
  NOW,
  SETTINGS_ID,
  TASK_ID,
  task,
  TIMER_ID,
} from '../test/fixtures';
import {
  predictServerVersion,
  type VersionPredictionOperation,
} from './version-predictor';

let operationNumber = 500;
function operation(value: Omit<SyncOperation, 'operationId' | 'createdAt'>) {
  operationNumber += 1;
  return SyncOperationSchema.parse({
    ...value,
    operationId:
      `00000000-0000-4000-8000-${String(operationNumber).padStart(12, '0')}`,
    createdAt: NOW,
  });
}

function pending(
  value: ReturnType<typeof operation>,
): VersionPredictionOperation {
  return { operation: value, state: 'pending', receipt: null };
}

describe('server version predictor', () => {
  it('always advances Task updates but applies semantic state operations once', () => {
    const operations = [
      pending(operation({
        entityType: 'task', entityId: TASK_ID, operationType: 'update',
        baseVersion: 1, payload: { title: task().title },
      })),
      pending(operation({
        entityType: 'task', entityId: TASK_ID, operationType: 'archive',
        baseVersion: 2, payload: {},
      })),
      pending(operation({
        entityType: 'task', entityId: TASK_ID, operationType: 'archive',
        baseVersion: 3, payload: {},
      })),
      pending(operation({
        entityType: 'task', entityId: TASK_ID, operationType: 'unarchive',
        baseVersion: 3, payload: {},
      })),
      pending(operation({
        entityType: 'task', entityId: TASK_ID, operationType: 'delete',
        baseVersion: 4, payload: {},
      })),
      pending(operation({
        entityType: 'task', entityId: TASK_ID, operationType: 'delete',
        baseVersion: 5, payload: {},
      })),
    ];
    expect(predictServerVersion(1, task(), operations)).toBe(5);
  });

  it('predicts DailyTask semantic operations and deletion once', () => {
    const create = pending(operation({
      entityType: 'dailyTask', entityId: DAILY_ID, operationType: 'create',
      baseVersion: 0,
      payload: {
        sourceTaskId: null, date: '2026-07-13', title: 'Vocabulary',
        subject: 'English', pomodoroTarget: 2,
        timerPreset: '25-5', sortOrder: 0,
      },
    }));
    const terminal = (
      operationType: 'complete' | 'restore' | 'delete',
      baseVersion: number,
    ) => pending(operation({
      entityType: 'dailyTask', entityId: DAILY_ID,
      operationType, baseVersion, payload: {},
    }));
    expect(predictServerVersion(0, null, [
      create,
      terminal('complete', 1),
      terminal('complete', 2),
      terminal('restore', 2),
      terminal('restore', 3),
      terminal('delete', 3),
      terminal('delete', 4),
    ])).toBe(4);
  });

  it('starts addToToday at version one and always advances update', () => {
    const add = pending(operation({
      entityType: 'dailyTask', entityId: DAILY_ID,
      operationType: 'addToToday', baseVersion: 0,
      payload: {
        sourceTaskId: TASK_ID, sourceTaskVersion: 1,
        date: '2026-07-13', sortOrder: 0,
      },
    }));
    const update = pending(operation({
      entityType: 'dailyTask', entityId: DAILY_ID,
      operationType: 'update', baseVersion: 1,
      payload: { title: 'Linear algebra' },
    }));
    expect(predictServerVersion(0, null, [add, update])).toBe(2);
  });

  it('always advances Settings updates', () => {
    const updates = [1, 2].map((baseVersion) => pending(operation({
      entityType: 'settings', entityId: SETTINGS_ID,
      operationType: 'update', baseVersion,
      payload: { soundEnabled: true },
    })));
    expect(predictServerVersion(1, null, updates)).toBe(3);
  });

  it('advances timer mutations and finalizes only once', () => {
    const start = pending(operation({
      entityType: 'activeTimer', entityId: TIMER_ID,
      operationType: 'timerStart', baseVersion: 0,
      payload: {
        dailyTaskId: DAILY_ID, dailyTaskVersion: 1,
        phase: 'focus', plannedSeconds: 1500,
      },
    }));
    const empty = (
      operationType: 'timerResume' | 'timerComplete',
      baseVersion: number,
    ) => pending(operation({
      entityType: 'activeTimer', entityId: TIMER_ID,
      operationType, baseVersion, payload: {},
    }));
    const pause = pending(operation({
      entityType: 'activeTimer', entityId: TIMER_ID,
      operationType: 'timerPause', baseVersion: 1,
      payload: { reason: 'Break' },
    }));
    const exit = pending(operation({
      entityType: 'activeTimer', entityId: TIMER_ID,
      operationType: 'timerExit', baseVersion: 4,
      payload: { reason: 'Done' },
    }));
    expect(predictServerVersion(0, null, [
      start, pause, empty('timerResume', 2),
      empty('timerComplete', 3), exit,
    ])).toBe(4);
  });

  it('uses acknowledged entityVersion as the authoritative prediction', () => {
    const createOperation = operation({
      entityType: 'task', entityId: TASK_ID, operationType: 'create',
      baseVersion: 0,
      payload: {
        title: 'Calculus', subject: 'Math', defaultPomodoroTarget: 3,
        defaultTimerPreset: '25-5', notes: null,
      },
    });
    const acknowledged: VersionPredictionOperation = {
      operation: createOperation,
      state: 'acknowledged',
      receipt: {
        operationId: createOperation.operationId,
        status: 'applied', entityVersion: 7,
        conflictId: null, errorCode: null, errorMessage: null,
      },
    };
    const archive = pending(operation({
      entityType: 'task', entityId: TASK_ID, operationType: 'archive',
      baseVersion: 7, payload: {},
    }));
    expect(predictServerVersion(0, null, [acknowledged, archive])).toBe(8);
  });

  it('ignores rejected and conflict operations', () => {
    const update = operation({
      entityType: 'task', entityId: TASK_ID, operationType: 'update',
      baseVersion: 1, payload: { title: 'Ignored' },
    });
    expect(predictServerVersion(1, task(), [
      { operation: update, state: 'rejected', receipt: null },
      { operation: update, state: 'conflict', receipt: null },
    ])).toBe(1);
  });
});
