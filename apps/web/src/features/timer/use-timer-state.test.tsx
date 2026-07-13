// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncDatabase, type SyncDatabase } from '../../db/database';
import {
  DAILY_ID,
  NOW,
  TIMER_ID,
  USER_A,
  activeTimer,
} from '../../test/fixtures';
import { OfflineOperationQueue } from '../../sync/queue';
import { useTimerState } from './use-timer-state';

function Probe({ database }: { database: SyncDatabase }) {
  const state = useTimerState(database, USER_A);
  return <p>{state.loaded
    ? `${state.viewModel.timer?.id ?? 'none'}:${state.viewModel.state}:${state.clockText}`
    : 'loading'}</p>;
}

describe('live timer state', () => {
  let database: SyncDatabase;
  beforeEach(async () => {
    database = createSyncDatabase(`timer-state-${crypto.randomUUID()}`);
    await database.open();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-07-13T04:10:00.000Z'));
  });
  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    await database.deleteDatabaseForTests();
  });

  it('reacts to another device pause, resume, replacement and removal', async () => {
    const running = activeTimer();
    await database.timerCache.put({
      userId: USER_A, serverTimer: running, projectedTimer: running,
      serverTime: NOW, receivedAt: '2026-07-13T04:09:59.000Z',
      clockOffsetMs: 0, clockUncertaintyMs: 20, pendingOperationIds: [],
    });
    render(<Probe database={database} />);
    expect(await screen.findByText(`${running.id}:running:15:00`)).toBeTruthy();

    const paused = {
      ...running,
      status: 'paused' as const,
      pausedAt: '2026-07-13T04:10:00.000Z',
      version: 2,
    };
    await database.timerCache.update(USER_A, {
      serverTimer: paused, projectedTimer: paused,
    });
    await waitFor(() => expect(screen.getByText(
      `${running.id}:paused:15:00`,
    )).toBeTruthy());

    const resumed = {
      ...running,
      id: '00000000-0000-4000-8000-000000000041',
      version: 1,
    };
    await database.timerCache.update(USER_A, {
      serverTimer: resumed, projectedTimer: resumed,
    });
    await waitFor(() => expect(screen.getByText(
      `${resumed.id}:running:15:00`,
    )).toBeTruthy());
    await database.timerCache.update(USER_A, {
      serverTimer: null, projectedTimer: null,
    });
    await waitFor(() => expect(screen.getByText('none:none:00:00')).toBeTruthy());
  });

  it('uses wall time on every tick without fetching an API', async () => {
    const running = activeTimer();
    await database.timerCache.put({
      userId: USER_A, serverTimer: running, projectedTimer: running,
      serverTime: NOW, receivedAt: '2026-07-13T04:09:59.000Z',
      clockOffsetMs: 0, clockUncertaintyMs: 20, pendingOperationIds: [],
    });
    render(<Probe database={database} />);
    expect(await screen.findByText(`${running.id}:running:15:00`)).toBeTruthy();
    vi.setSystemTime(new Date('2026-07-13T04:10:02.000Z'));
    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => expect(screen.getByText(
      `${running.id}:running:14:58`,
    )).toBeTruthy());
  });

  it('restores an offline provisional countdown from IndexedDB after restart', async () => {
    vi.useRealTimers();
    const name = database.name;
    const queue = new OfflineOperationQueue(database, USER_A, {
      now: () => new Date('2026-07-13T04:01:00.000Z'),
    });
    await queue.createDailyTask(DAILY_ID, {
      sourceTaskId: null, date: '2026-07-13', title: 'Vocabulary',
      subject: 'English', pomodoroTarget: 2,
      timerPreset: '25-5', sortOrder: 0,
    });
    await queue.startTimerForDailyTask(TIMER_ID, DAILY_ID, 'focus', 1_500);
    database.close();
    database = createSyncDatabase(name);
    await database.open();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-07-13T04:10:00.000Z'));

    render(<Probe database={database} />);

    expect(await screen.findByText(`${TIMER_ID}:starting:16:00`)).toBeTruthy();
  });
});
