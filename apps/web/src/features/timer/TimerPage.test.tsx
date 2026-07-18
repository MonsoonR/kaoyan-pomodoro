// @vitest-environment jsdom
import { StrictMode } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncDatabase, type SyncDatabase } from '../../db/database';
import type { TimerStateSnapshot } from './use-timer-state';
import { OfflineOperationQueue } from '../../sync/queue';
import { NOW, USER_A, activeTimer, dailyTask } from '../../test/fixtures';
import { TimerPage } from './TimerPage';

function snapshot(
  timer: ReturnType<typeof activeTimer>,
  state: 'running' | 'paused' = timer.status,
): TimerStateSnapshot {
  return {
    loaded: true,
    viewModel: {
      state,
      timer,
      serverTimer: timer,
      pending: false,
      provisional: false,
      reconciliation: null,
    },
    clock: {
      nowMs: Date.parse('2026-07-13T04:10:00.000Z'),
      uncertaintyMs: 0,
      calibration: 'calibrated',
      reliable: true,
    },
    clockLabel: '计时准确',
    remainingMs: 0,
    clockText: '00:00',
  };
}

describe('timer page', () => {
  let database: SyncDatabase;
  let queue: OfflineOperationQueue;
  beforeEach(async () => {
    database = createSyncDatabase(`timer-page-${crypto.randomUUID()}`);
    await database.open();
    queue = new OfflineOperationQueue(database, USER_A);
  });
  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await database.deleteDatabaseForTests();
  });

  it('enqueues at most one completion in React StrictMode', async () => {
    const timer = activeTimer({ targetEndAt: '2026-07-13T04:25:00.000Z' });
    await database.timerCache.put({
      userId: USER_A, serverTimer: timer, projectedTimer: timer,
      serverTime: NOW, receivedAt: NOW, clockOffsetMs: 0,
      clockUncertaintyMs: 0, pendingOperationIds: [],
    });
    render(<StrictMode><TimerPage
      timerState={{
        ...snapshot(timer),
        clock: {
          ...snapshot(timer).clock,
          nowMs: Date.parse('2026-07-13T04:30:00.000Z'),
        },
      }}
      task={dailyTask()}
      queue={queue}
      onBack={vi.fn()}
      onStartPhase={vi.fn()}
      onConfirmTask={vi.fn()}
      onTimerSwitch={vi.fn()}
      onManualSync={vi.fn()}
      onMessage={vi.fn()}
    /></StrictMode>);
    await waitFor(async () => expect((await database.operations.toArray()).filter(
      (row) => row.operation.operationType === 'timerComplete',
    )).toHaveLength(1));
    expect(screen.getByLabelText('剩余时间 00:00')).toBeTruthy();
  });

  it('does not complete a confirmed timer before a high-uncertainty boundary', async () => {
    const target = Date.parse('2026-07-13T04:10:00.000Z');
    const timer = activeTimer({ targetEndAt: new Date(target).toISOString() });
    await database.timerCache.put({
      userId: USER_A, serverTimer: timer, projectedTimer: timer,
      serverTime: NOW, receivedAt: NOW, clockOffsetMs: 0,
      clockUncertaintyMs: 5_000, pendingOperationIds: [],
    });
    render(<TimerPage
      timerState={{
        ...snapshot(timer),
        clock: {
          nowMs: target + 4_999,
          uncertaintyMs: 5_000,
          calibration: 'uncertain',
          reliable: false,
        },
      }}
      task={dailyTask()}
      queue={queue}
      onBack={vi.fn()}
      onStartPhase={vi.fn()}
      onConfirmTask={vi.fn()}
      onTimerSwitch={vi.fn()}
      onManualSync={vi.fn()}
      onMessage={vi.fn()}
    />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await database.operations.count()).toBe(0);
  });

  it('completes once when a high-uncertainty safety boundary is reached', async () => {
    const target = Date.parse('2026-07-13T04:10:00.000Z');
    const timer = activeTimer({ targetEndAt: new Date(target).toISOString() });
    await database.timerCache.put({
      userId: USER_A, serverTimer: timer, projectedTimer: timer,
      serverTime: NOW, receivedAt: NOW, clockOffsetMs: 0,
      clockUncertaintyMs: 5_000, pendingOperationIds: [],
    });
    const timerState = {
      ...snapshot(timer),
      clock: {
        nowMs: target + 5_000,
        uncertaintyMs: 5_000,
        calibration: 'uncertain' as const,
        reliable: false,
      },
    };
    const props = {
      timerState,
      task: dailyTask(),
      queue,
      onBack: vi.fn(),
      onStartPhase: vi.fn(),
      onConfirmTask: vi.fn(),
      onTimerSwitch: vi.fn(),
      onManualSync: vi.fn(),
      onMessage: vi.fn(),
    };
    const { rerender } = render(<StrictMode><TimerPage {...props} /></StrictMode>);
    rerender(<StrictMode><TimerPage {...props} /></StrictMode>);
    await waitFor(async () => expect((await database.operations.toArray()).filter(
      (row) => row.operation.operationType === 'timerComplete',
    )).toHaveLength(1));
  });

  it('does not immediately complete again after adopting TIMER_NOT_ELAPSED', async () => {
    const target = Date.parse('2026-07-13T04:10:00.000Z');
    const timer = activeTimer({ targetEndAt: new Date(target).toISOString() });
    await database.timerCache.put({
      userId: USER_A, serverTimer: timer, projectedTimer: timer,
      serverTime: NOW, receivedAt: NOW, clockOffsetMs: 0,
      clockUncertaintyMs: 5_000, pendingOperationIds: [],
    });
    const rejected = await queue.completeTimer(timer.id);
    await database.operations.update(rejected.sequence ?? 0, { state: 'rejected' });
    await database.syncIssues.put({
      operationId: rejected.operationId,
      userId: USER_A,
      errorCode: 'TIMER_NOT_ELAPSED',
      errorMessage: 'not elapsed',
      operation: rejected.operation,
      createdAt: NOW,
    });
    const baseState = {
      ...snapshot(timer),
      clock: {
        nowMs: target + 1_000,
        uncertaintyMs: 5_000,
        calibration: 'uncertain' as const,
        reliable: false,
      },
    };
    const props = {
      task: dailyTask(), queue, onBack: vi.fn(), onStartPhase: vi.fn(),
      onConfirmTask: vi.fn(), onTimerSwitch: vi.fn(), onManualSync: vi.fn(),
      onMessage: vi.fn(),
    };
    const { rerender } = render(<TimerPage
      {...props}
      timerState={{
        ...baseState,
        viewModel: {
          ...baseState.viewModel,
          state: 'reconciling',
          reconciliation: {
            operationId: rejected.operationId,
            operationCreatedAt: NOW,
            attemptedAction: '完成',
            errorCode: 'TIMER_NOT_ELAPSED',
            explanation: '计时尚未到时，将继续倒计时。',
            serverDescription: '服务器计时器当前为运行中',
            canRetry: true,
            canSwitchToTimer: false,
          },
        },
      }}
    />);
    screen.getByRole('button', { name: '保留当前状态' }).click();
    await waitFor(async () => expect(await database.operations.get(
      rejected.sequence ?? 0,
    )).toBeUndefined());
    rerender(<TimerPage {...props} timerState={baseState} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await database.operations.toArray()).filter(
      (row) => row.operation.operationType === 'timerComplete',
    )).toHaveLength(0);
  });

  it('settles a real stale retry while the original issue remains visible', async () => {
    const timer = activeTimer({ version: 4 });
    await database.timerCache.put({
      userId: USER_A, serverTimer: timer, projectedTimer: timer,
      serverTime: NOW, receivedAt: NOW, clockOffsetMs: 0,
      clockUncertaintyMs: 20, pendingOperationIds: [],
    });
    const rejected = await queue.enqueueOperation({
      entityType: 'activeTimer', entityId: timer.id,
      operationType: 'timerPause', baseVersion: 1,
      payload: { reason: '临时有事' },
    });
    await database.operations.update(rejected.sequence ?? 0, {
      state: 'rejected',
      lastError: { code: 'STALE_TIMER_VERSION', message: 'stale' },
    });
    await database.syncIssues.put({
      operationId: rejected.operationId,
      userId: USER_A,
      errorCode: 'STALE_TIMER_VERSION',
      errorMessage: 'stale',
      operation: rejected.operation,
      createdAt: NOW,
    });
    const timerState: TimerStateSnapshot = {
      ...snapshot(timer),
      viewModel: {
        ...snapshot(timer).viewModel,
        state: 'reconciling',
        reconciliation: {
          operationId: rejected.operationId,
          operationCreatedAt: NOW,
          attemptedAction: '暂停',
          errorCode: 'STALE_TIMER_VERSION',
          explanation: '计时状态已经变化，请确认要保留的内容。',
          serverDescription: '服务器计时器当前为运行中',
          canRetry: true,
          canSwitchToTimer: true,
        },
      },
    };
    render(<TimerPage
      timerState={timerState}
      task={dailyTask()}
      queue={queue}
      onBack={vi.fn()}
      onStartPhase={vi.fn()}
      onConfirmTask={vi.fn()}
      onTimerSwitch={vi.fn()}
      onManualSync={vi.fn()}
      onMessage={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: '重新尝试暂停' }));

    expect(await screen.findByRole('button', {
      name: '已重新尝试，正在更新',
    })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '保留当前状态' }))
      .toHaveProperty('disabled', false);
    expect(await database.syncIssues.get({ operationId: rejected.operationId }))
      .toBeTruthy();
    const afterRetry = (await database.operations.toArray()).filter(
      (row) => row.operation.operationType === 'timerPause',
    );
    expect(afterRetry).toHaveLength(2);
    expect(afterRetry[1]?.operationId).not.toBe(rejected.operationId);
    expect(afterRetry[0]?.state).toBe('rejected');

    fireEvent.click(screen.getByRole('button', {
      name: '已重新尝试，正在更新',
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await database.operations.toArray()).filter(
      (row) => row.operation.operationType === 'timerPause',
    )).toHaveLength(2);
  });

  it('still completes a provisional offline timer from local time once', async () => {
    const target = Date.parse('2026-07-13T04:10:00.000Z');
    queue = new OfflineOperationQueue(database, USER_A, {
      now: () => new Date(target - 1_500_000),
    });
    await queue.startTimer(activeTimer().id, {
      dailyTaskId: dailyTask().id,
      dailyTaskVersion: 1,
      phase: 'focus',
      plannedSeconds: 1_500,
    });
    const timer = (await database.timerCache.get(USER_A))?.projectedTimer;
    if (!timer) throw new Error('Expected a provisional timer projection');
    render(<StrictMode><TimerPage
      timerState={{
        ...snapshot(activeTimer()),
        viewModel: {
          ...snapshot(activeTimer()).viewModel,
          state: 'starting',
          timer,
          serverTimer: null,
          pending: true,
          provisional: true,
        },
        clock: {
          nowMs: target,
          uncertaintyMs: 0,
          calibration: 'missing',
          reliable: false,
        },
      }}
      task={dailyTask()}
      queue={queue}
      onBack={vi.fn()}
      onStartPhase={vi.fn()}
      onConfirmTask={vi.fn()}
      onTimerSwitch={vi.fn()}
      onManualSync={vi.fn()}
      onMessage={vi.fn()}
    /></StrictMode>);
    await waitFor(async () => expect((await database.operations.toArray()).filter(
      (row) => row.operation.operationType === 'timerComplete',
    )).toHaveLength(1));
  });

  it('never auto-completes a paused timer', async () => {
    const timer = {
      ...activeTimer(),
      status: 'paused' as const,
      pausedAt: '2026-07-13T04:10:00.000Z',
    };
    render(<TimerPage
      timerState={snapshot(timer, 'paused')}
      task={dailyTask()}
      queue={queue}
      onBack={vi.fn()}
      onStartPhase={vi.fn()}
      onConfirmTask={vi.fn()}
      onTimerSwitch={vi.fn()}
      onManualSync={vi.fn()}
      onMessage={vi.fn()}
    />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await database.operations.count()).toBe(0);
    expect(screen.getByRole('button', { name: '继续计时器' })).toBeTruthy();
  });

  it('does not create a focusSession in the client database', async () => {
    const timer = activeTimer();
    render(<TimerPage
      timerState={{ ...snapshot(timer), remainingMs: 1_000, clockText: '00:01' }}
      task={dailyTask()}
      queue={queue}
      onBack={vi.fn()}
      onStartPhase={vi.fn()}
      onConfirmTask={vi.fn()}
      onTimerSwitch={vi.fn()}
      onManualSync={vi.fn()}
      onMessage={vi.fn()}
    />);
    expect((await database.operations.toArray()).some(
      (row) => row.entityType === 'focusSession',
    )).toBe(false);
  });

  it('shows reconciliation when a stale control has no server timer', () => {
    render(<TimerPage
      timerState={{
        ...snapshot(activeTimer()),
        viewModel: {
          state: 'reconciling', timer: null, serverTimer: null,
          pending: false, provisional: false,
          reconciliation: {
            operationId: 'operation', operationCreatedAt: NOW,
            attemptedAction: '暂停', errorCode: 'TIMER_NOT_ACTIVE',
            explanation: '这个计时已经结束。',
            serverDescription: '计时器已在其他设备结束',
            canRetry: false, canSwitchToTimer: false,
          },
        },
        remainingMs: 0,
        clockText: '00:00',
      }}
      task={dailyTask()}
      queue={queue}
      onBack={vi.fn()}
      onStartPhase={vi.fn()}
      onConfirmTask={vi.fn()}
      onTimerSwitch={vi.fn()}
      onManualSync={vi.fn()}
      onMessage={vi.fn()}
    />);
    expect(screen.getByText('这个计时已经结束。')).toBeTruthy();
    expect(screen.queryByText('计时器已结束')).toBeNull();
  });
});
