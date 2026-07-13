import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseConnection } from '../db/client';
import { migrateDatabase } from '../db/migrate';
import {
  defaultChangeLogWriter,
  type ChangeInput,
} from './common';
import { createTimerService, type TimerDependencies } from './timer';

const userId = '71000000-0000-4000-8000-000000000001';
const dailyId = '72000000-0000-4000-8000-000000000001';
const timerId = '73000000-0000-4000-8000-000000000001';

describe('timer finalization transaction failures', () => {
  let connection: DatabaseConnection;
  let directory: string;
  let now: number;

  beforeEach(() => {
    now = Date.parse('2026-07-13T10:00:00.000Z');
    directory = mkdtempSync(join(tmpdir(), 'timer-transaction-'));
    connection = openDatabase(join(directory, 'db.sqlite'));
    migrateDatabase(connection.db);
    connection.sqlite
      .prepare(`INSERT INTO users(
        id,singleton_key,username,password_hash,password_changed_at,
        created_at,updated_at
      ) VALUES (?,1,'owner','hash',?,?,?)`)
      .run(userId, now, now, now);
    connection.sqlite
      .prepare(`INSERT INTO daily_tasks(
        id,user_id,source_task_id,date,title,subject,pomodoro_target,
        pomodoro_completed,timer_preset,status,sort_order,completed_at,
        version,created_at,updated_at,deleted_at
      ) VALUES (?, ?, NULL, '2026-07-13', 'Snapshot title', 'Math', 2,
        0, '25-5', 'pending', 0, NULL, 1, ?, ?, NULL)`)
      .run(dailyId, userId, now, now);
    service().startTimer(userId, {
      id: timerId,
      dailyTaskId: dailyId,
      dailyTaskVersion: 1,
      phase: 'focus',
      plannedSeconds: 60,
    });
    connection.sqlite.prepare('DELETE FROM sync_changes').run();
    now += 60_000;
  });

  afterEach(() => {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const service = (overrides: Partial<TimerDependencies> = {}) =>
    createTimerService({
      sqlite: connection.sqlite,
      now: () => new Date(now),
      ...overrides,
    });
  const expectUnchanged = () => {
    expect(
      connection.sqlite
        .prepare(
          'SELECT status,pomodoro_completed,version FROM daily_tasks WHERE id=?',
        )
        .get(dailyId),
    ).toEqual({ status: 'active', pomodoro_completed: 0, version: 2 });
    expect(
      connection.sqlite
        .prepare('SELECT version,deleted_at FROM active_timer WHERE id=?')
        .get(timerId),
    ).toEqual({ version: 1, deleted_at: null });
    expect(
      connection.sqlite.prepare('SELECT count(*) count FROM focus_sessions').get(),
    ).toEqual({ count: 0 });
    expect(
      connection.sqlite.prepare('SELECT count(*) count FROM sync_changes').get(),
    ).toEqual({ count: 0 });
  };
  const failChange = (predicate: (input: ChangeInput) => boolean) =>
    service({
      writeChange: (sqlite, input) => {
        if (predicate(input)) throw new Error('injected change failure');
        defaultChangeLogWriter(sqlite, input);
      },
    });

  it('rolls back when FocusSession insertion fails', () => {
    const timer = service({
      insertSession: () => {
        throw new Error('injected session failure');
      },
    });
    expect(() =>
      timer.completeTimer(userId, timerId, { expectedVersion: 1 }),
    ).toThrow('injected session failure');
    expectUnchanged();
  });

  it('rolls back when the DailyTask change cannot be written', () => {
    const timer = failChange((input) => input.entityType === 'dailyTask');
    expect(() =>
      timer.completeTimer(userId, timerId, { expectedVersion: 1 }),
    ).toThrow('injected change failure');
    expectUnchanged();
  });

  it('rolls back every finalization write when ActiveTimer delete change fails', () => {
    const timer = failChange(
      (input) =>
        input.entityType === 'activeTimer' && input.changeType === 'delete',
    );
    expect(() =>
      timer.completeTimer(userId, timerId, { expectedVersion: 1 }),
    ).toThrow('injected change failure');
    expectUnchanged();
  });
});
