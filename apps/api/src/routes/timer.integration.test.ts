import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { initializeAccount } from '../auth/account-service';
import { TEST_PASSWORD_OPTIONS } from '../auth/password';
import { openDatabase, type DatabaseConnection } from '../db/client';
import { migrateDatabase } from '../db/migrate';

const origin = 'https://example.test';
const password = 'correct horse battery staple';
const dailyId = '61000000-0000-4000-8000-000000000001';
const timerId = '62000000-0000-4000-8000-000000000001';
const otherTimerId = '62000000-0000-4000-8000-000000000002';
const headers = { origin, 'content-type': 'application/json' };

describe('timer HTTP API', () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let connection: DatabaseConnection;
  let directory: string;
  let cookie: string;
  let now: number;

  beforeEach(async () => {
    now = Date.parse('2026-07-13T10:00:00.000Z');
    directory = mkdtempSync(join(tmpdir(), 'task6-timer-'));
    connection = openDatabase(join(directory, 'db.sqlite'));
    migrateDatabase(connection.db);
    await initializeAccount(
      connection.sqlite,
      { username: 'learner', password, confirmPassword: password },
      TEST_PASSWORD_OPTIONS,
    );
    app = await createApp({
      database: connection,
      appOrigin: origin,
      now: () => new Date(now),
      passwordOptions: TEST_PASSWORD_OPTIONS,
      logger: false,
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers,
      payload: { username: 'learner', password },
    });
    cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    await createDailyTask();
  });

  afterEach(async () => {
    await app.close();
    if (connection.sqlite.open) connection.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const request = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) => {
    const options = {
      method,
      url,
      headers: payload === undefined ? { cookie } : { ...headers, cookie },
    };
    return payload === undefined
      ? app.inject(options)
      : app.inject({ ...options, payload });
  };
  const createDailyTask = (id = dailyId) =>
    request('POST', '/api/daily-tasks', {
      id,
      date: '2026-07-13',
      title: 'Linear algebra',
      subject: 'Math',
      pomodoroTarget: 2,
      timerPreset: '25-5',
      sortOrder: 0,
    });
  const start = (
    phase: 'focus' | 'short_break' | 'long_break' = 'focus',
    id = timerId,
    dailyTaskVersion = 1,
    plannedSeconds = 60,
  ) =>
    request('POST', '/api/timer/start', {
      id,
      dailyTaskId: dailyId,
      dailyTaskVersion,
      phase,
      plannedSeconds,
    });

  it('requires authentication and returns an empty authoritative state without writes', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/timer' })).statusCode).toBe(401);
    const before = connection.sqlite.prepare('SELECT count(*) count FROM sync_changes').get();
    const response = await request('GET', '/api/timer');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      timer: null,
      serverTime: '2026-07-13T10:00:00.000Z',
    });
    expect(connection.sqlite.prepare('SELECT count(*) count FROM sync_changes').get()).toEqual(before);
  });

  it('starts focus from server time, snapshots the task and returns existing globally', async () => {
    const secondLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...headers, 'user-agent': 'Second device browser' },
      payload: { username: 'learner', password },
    });
    const secondCookie = String(secondLogin.headers['set-cookie']).split(';')[0] ?? '';
    const [first, second] = await Promise.all([
      start(),
      app.inject({
        method: 'POST',
        url: '/api/timer/start',
        headers: { ...headers, cookie: secondCookie },
        payload: {
          id: otherTimerId,
          dailyTaskId: dailyId,
          dailyTaskVersion: 1,
          phase: 'focus',
          plannedSeconds: 60,
        },
      }),
    ]);
    expect(first.json()).toMatchObject({
      outcome: 'started',
      timer: {
        id: timerId,
        taskTitle: 'Linear algebra',
        subject: 'Math',
        status: 'running',
        version: 1,
        startedAt: '2026-07-13T10:00:00.000Z',
        targetEndAt: '2026-07-13T10:01:00.000Z',
      },
    });
    expect(second.json()).toMatchObject({ outcome: 'existing', timer: { id: timerId } });
    expect(connection.sqlite.prepare('SELECT count(*) count FROM active_timer WHERE deleted_at IS NULL').get()).toEqual({ count: 1 });
    expect(connection.sqlite.prepare("SELECT count(*) count FROM sync_changes WHERE entity_type='activeTimer'").get()).toEqual({ count: 1 });
    expect(connection.sqlite.prepare('SELECT status,version FROM daily_tasks WHERE id=?').get(dailyId)).toEqual({ status: 'active', version: 2 });
  });

  it('starts a break without changing the daily task', async () => {
    const response = await start('short_break');
    expect(response.json()).toMatchObject({ outcome: 'started', timer: { phase: 'short_break' } });
    expect(connection.sqlite.prepare('SELECT status,version FROM daily_tasks WHERE id=?').get(dailyId)).toEqual({ status: 'pending', version: 1 });
  });

  it('rejects deleted, stale, invalid-state and historically used starts', async () => {
    expect((await start('focus', timerId, 2)).json()).toMatchObject({ code: 'STALE_VERSION', currentVersion: 1 });
    connection.sqlite.prepare("UPDATE daily_tasks SET status='completed' WHERE id=?").run(dailyId);
    expect((await start()).json()).toMatchObject({ code: 'INVALID_DAILY_TASK_STATE' });
    connection.sqlite.prepare("UPDATE daily_tasks SET status='pending',deleted_at=? WHERE id=?").run(now, dailyId);
    expect((await start()).json()).toMatchObject({ code: 'DAILY_TASK_NOT_AVAILABLE' });
    connection.sqlite.prepare('UPDATE daily_tasks SET deleted_at=NULL WHERE id=?').run(dailyId);
    await start('short_break');
    await request('POST', `/api/timer/${timerId}/exit`, { expectedVersion: 1, reason: 'Switching tasks' });
    expect((await start('short_break')).json()).toMatchObject({ code: 'TIMER_ID_ALREADY_USED' });
  });

  it('pauses with optimistic locking and resumes using exact server-time math', async () => {
    await start();
    now += 10_250;
    const paused = await request('POST', `/api/timer/${timerId}/pause`, {
      expectedVersion: 1,
      reason: 'Water break',
    });
    expect(paused.json().timer).toMatchObject({ status: 'paused', version: 2, interruptionReason: 'Water break' });
    const changes = (connection.sqlite.prepare('SELECT count(*) count FROM sync_changes').get() as { count: number }).count;
    expect((await request('POST', `/api/timer/${timerId}/pause`, { expectedVersion: 1, reason: 'Again' })).json()).toMatchObject({
      code: 'STALE_TIMER_VERSION',
      currentVersion: 2,
      currentTimer: { status: 'paused' },
      serverTime: new Date(now).toISOString(),
    });
    expect((connection.sqlite.prepare('SELECT count(*) count FROM sync_changes').get() as { count: number }).count).toBe(changes);
    now += 5_900;
    const resumed = await request('POST', `/api/timer/${timerId}/resume`, { expectedVersion: 2 });
    expect(resumed.json().timer).toMatchObject({
      status: 'running',
      version: 3,
      accumulatedPausedSeconds: 5,
      targetEndAt: '2026-07-13T10:01:05.900Z',
    });
    now += 4_100;
    await request('POST', `/api/timer/${timerId}/pause`, { expectedVersion: 3, reason: 'Second pause' });
    now += 2_100;
    const secondResume = await request('POST', `/api/timer/${timerId}/resume`, { expectedVersion: 4 });
    expect(secondResume.json().timer).toMatchObject({
      accumulatedPausedSeconds: 7,
      targetEndAt: '2026-07-13T10:01:08.000Z',
    });
  });

  it('rejects pause after elapsed and resume when server time moved backwards', async () => {
    await start();
    now += 60_000;
    expect((await request('POST', `/api/timer/${timerId}/pause`, { expectedVersion: 1, reason: 'Late' })).json()).toMatchObject({ code: 'TIMER_ALREADY_ELAPSED' });
    now -= 50_000;
    await request('POST', `/api/timer/${timerId}/pause`, { expectedVersion: 1, reason: 'Pause' });
    now -= 1;
    expect((await request('POST', `/api/timer/${timerId}/resume`, { expectedVersion: 2 })).json()).toMatchObject({ code: 'SERVER_TIME_MOVED_BACKWARDS' });
  });

  it('completes focus exactly once and rejects an opposite terminal retry', async () => {
    await start();
    expect((await request('POST', `/api/timer/${timerId}/complete`, { expectedVersion: 1 })).json()).toMatchObject({ code: 'TIMER_NOT_ELAPSED' });
    now += 60_000;
    const completed = await request('POST', `/api/timer/${timerId}/complete`, { expectedVersion: 1 });
    expect(completed.json()).toMatchObject({
      outcome: 'finalized',
      focusSession: { id: timerId, result: 'completed', effectiveSeconds: 60, version: 1 },
    });
    expect(connection.sqlite.prepare('SELECT status,pomodoro_completed,version FROM daily_tasks WHERE id=?').get(dailyId)).toEqual({ status: 'pending', pomodoro_completed: 1, version: 3 });
    const counts = connection.sqlite.prepare('SELECT (SELECT count(*) FROM focus_sessions) sessions,(SELECT count(*) FROM sync_changes) changes').get();
    expect((await request('POST', `/api/timer/${timerId}/complete`, { expectedVersion: 1 })).json()).toMatchObject({ outcome: 'alreadyFinalized', focusSession: { id: timerId } });
    expect(connection.sqlite.prepare('SELECT (SELECT count(*) FROM focus_sessions) sessions,(SELECT count(*) FROM sync_changes) changes').get()).toEqual(counts);
    expect((await request('POST', `/api/timer/${timerId}/exit`, { expectedVersion: 2, reason: 'No' })).json()).toMatchObject({ code: 'TIMER_ALREADY_FINALIZED' });
  });

  it('moves focus to awaiting confirmation at its target', async () => {
    connection.sqlite.prepare('UPDATE daily_tasks SET pomodoro_completed=1 WHERE id=?').run(dailyId);
    await start();
    now += 60_000;
    await request('POST', `/api/timer/${timerId}/complete`, { expectedVersion: 1 });
    expect(connection.sqlite.prepare('SELECT status,pomodoro_completed,completed_at FROM daily_tasks WHERE id=?').get(dailyId)).toEqual({ status: 'awaiting_confirmation', pomodoro_completed: 2, completed_at: null });
  });

  it('completes break without modifying the daily task', async () => {
    await start('long_break');
    now += 60_000;
    await request('POST', `/api/timer/${timerId}/complete`, { expectedVersion: 1 });
    expect(connection.sqlite.prepare('SELECT status,version FROM daily_tasks WHERE id=?').get(dailyId)).toEqual({ status: 'pending', version: 1 });
  });

  it('exits running and paused timers with clamped authoritative effective seconds', async () => {
    await start('focus', timerId, 1, 60);
    now += 10_100;
    const exited = await request('POST', `/api/timer/${timerId}/exit`, { expectedVersion: 1, reason: 'Interrupted' });
    expect(exited.json()).toMatchObject({ focusSession: { result: 'interrupted', effectiveSeconds: 10, interruptionReason: 'Interrupted' } });
    expect(connection.sqlite.prepare('SELECT status,pomodoro_completed FROM daily_tasks WHERE id=?').get(dailyId)).toEqual({ status: 'pending', pomodoro_completed: 0 });

    const secondDaily = '61000000-0000-4000-8000-000000000002';
    await createDailyTask(secondDaily);
    await request('POST', '/api/timer/start', { id: otherTimerId, dailyTaskId: secondDaily, dailyTaskVersion: 1, phase: 'short_break', plannedSeconds: 60 });
    now += 15_900;
    await request('POST', `/api/timer/${otherTimerId}/pause`, { expectedVersion: 1, reason: 'Paused' });
    now += 30_000;
    const pausedExit = await request('POST', `/api/timer/${otherTimerId}/exit`, { expectedVersion: 2, reason: 'Done' });
    expect(pausedExit.json()).toMatchObject({ focusSession: { effectiveSeconds: 15 } });
  });

  it('locks terminal daily-task operations but allows ordinary edits until timer ends', async () => {
    await start();
    for (const [method, url] of [
      ['POST', `/api/daily-tasks/${dailyId}/complete`],
      ['POST', `/api/daily-tasks/${dailyId}/restore`],
      ['DELETE', `/api/daily-tasks/${dailyId}`],
    ] as const) {
      const response = await request(method, url, { expectedVersion: 2 });
      expect(response.json()).toMatchObject({ code: 'ACTIVE_TIMER_TASK_LOCKED' });
    }
    expect((await request('PATCH', `/api/daily-tasks/${dailyId}`, { expectedVersion: 2, title: 'Updated title' })).json()).toMatchObject({ title: 'Updated title', version: 3 });
    const exited = await request('POST', `/api/timer/${timerId}/exit`, {
      expectedVersion: 1,
      reason: 'Stop',
    });
    expect(exited.json().focusSession.taskTitle).toBe('Linear algebra');
    expect((await request('DELETE', `/api/daily-tasks/${dailyId}`, { expectedVersion: 4 })).statusCode).toBe(200);
  });
});
