import { SyncOperationSchema } from '@kaoyan/contracts';
import { describe, expect, it } from 'vitest';
import type { OperationRow, SyncIssueRow } from '../../db/types';
import {
  DAILY_ID,
  NOW,
  TIMER_ID,
  USER_A,
  activeTimer,
} from '../../test/fixtures';
import { buildTimerViewModel } from './timer-view-model';

let serial = 100;
function timerOperation(
  operationType: 'timerStart' | 'timerPause' | 'timerResume' |
    'timerComplete' | 'timerExit',
  payload: Record<string, unknown>,
  state: OperationRow['state'] = 'pending',
  createdAt = NOW,
): OperationRow {
  serial += 1;
  const operation = SyncOperationSchema.parse({
    operationId: `10000000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
    entityType: 'activeTimer',
    entityId: TIMER_ID,
    operationType,
    baseVersion: operationType === 'timerStart' ? 0 : 1,
    payload,
    createdAt,
  });
  return {
    sequence: serial,
    operationId: operation.operationId,
    userId: USER_A,
    operation,
    entityType: 'activeTimer',
    entityId: TIMER_ID,
    state,
    attempts: 0,
    enqueuedAt: createdAt,
    lastAttemptAt: null,
    receipt: null,
    lastError: null,
    conflictId: null,
    projectionSeed: null,
  };
}

function issue(row: OperationRow, errorCode: string): SyncIssueRow {
  return {
    operationId: row.operationId,
    userId: USER_A,
    errorCode,
    errorMessage: errorCode,
    operation: row.operation,
    createdAt: NOW,
  };
}

describe('timer view model', () => {
  it('represents confirmed running and paused timers', () => {
    expect(buildTimerViewModel({
      serverTimer: activeTimer(), operations: [], syncIssues: [],
    })).toMatchObject({ state: 'running', pending: false });
    expect(buildTimerViewModel({
      serverTimer: {
        ...activeTimer(), status: 'paused', pausedAt: NOW,
      },
      operations: [], syncIssues: [],
    })).toMatchObject({ state: 'paused', pending: false });
  });

  it.each([
    ['timerPause', { reason: '临时有事' }, 'pausing'],
    ['timerResume', {}, 'resuming'],
    ['timerComplete', {}, 'completing'],
    ['timerExit', { reason: '计划调整' }, 'exiting'],
  ] as const)('folds pending %s into %s', (kind, payload, state) => {
    const base = kind === 'timerResume'
      ? { ...activeTimer(), status: 'paused' as const, pausedAt: NOW }
      : activeTimer();
    expect(buildTimerViewModel({
      serverTimer: base,
      operations: [timerOperation(kind, payload)],
      syncIssues: [],
    })).toMatchObject({ state, pending: true });
  });

  it('rebuilds an offline starting countdown from the persisted createdAt', () => {
    const start = timerOperation('timerStart', {
      dailyTaskId: DAILY_ID,
      dailyTaskVersion: 2,
      phase: 'focus',
      plannedSeconds: 1_500,
    }, 'pending', '2026-07-13T04:01:00.000Z');
    const model = buildTimerViewModel({
      serverTimer: null, operations: [start], syncIssues: [],
    });
    expect(model).toMatchObject({
      state: 'starting', pending: true, provisional: true,
      timer: {
        id: TIMER_ID,
        dailyTaskId: DAILY_ID,
        startedAt: '2026-07-13T04:01:00.000Z',
        targetEndAt: '2026-07-13T04:26:00.000Z',
      },
    });
  });

  it('exposes rejected stale controls without replacing server truth', () => {
    const rejected = timerOperation(
      'timerPause',
      { reason: '注意力分散' },
      'rejected',
    );
    const model = buildTimerViewModel({
      serverTimer: activeTimer({ version: 2 }),
      operations: [rejected],
      syncIssues: [issue(rejected, 'STALE_TIMER_VERSION')],
    });
    expect(model).toMatchObject({
      state: 'reconciling',
      timer: { status: 'running', version: 2 },
      reconciliation: {
        operationId: rejected.operationId,
        attemptedAction: '暂停',
        errorCode: 'STALE_TIMER_VERSION',
        canRetry: true,
      },
    });
  });

  it('states when another device already ended the timer', () => {
    const rejected = timerOperation('timerResume', {}, 'rejected');
    expect(buildTimerViewModel({
      serverTimer: null,
      operations: [rejected],
      syncIssues: [issue(rejected, 'TIMER_NOT_ACTIVE')],
    }).reconciliation).toMatchObject({
      serverDescription: '计时器已在其他设备结束',
      canRetry: false,
    });
  });
});
