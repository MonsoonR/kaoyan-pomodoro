// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
    clockLabel: '已按服务器时间校准',
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
            explanation: '服务器上已没有这个活动计时器。',
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
    expect(screen.getByText('计时器已在其他设备结束')).toBeTruthy();
    expect(screen.queryByText('计时器已结束')).toBeNull();
  });
});
