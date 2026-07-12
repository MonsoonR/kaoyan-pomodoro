import { DailyTaskSchema, SettingsSchema, TaskSchema } from '@kaoyan/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseConnection } from '../db/client';
import { migrateDatabase } from '../db/migrate';
import { createDailyTaskService } from './daily-tasks';
import { StaleVersionError } from './errors';
import { createSettingsService } from './settings';
import { createTaskService } from './tasks';

const user = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333',
  dailyId = '44444444-4444-4444-8444-444444444444';
let db: DatabaseConnection, dir: string, clock: Date;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'task4-'));
  db = openDatabase(join(dir, 'db.sqlite'));
  migrateDatabase(db.db);
  db.sqlite.pragma('ignore_check_constraints = ON');
  clock = new Date('2026-07-13T01:02:03.000Z');
  for (const [id, key] of [
    [user, 1],
    [other, 2],
  ] as const)
    db.sqlite
      .prepare(
        `INSERT INTO users(id,singleton_key,username,password_hash,password_changed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        key,
        `u${key}`,
        'hash',
        clock.getTime(),
        clock.getTime(),
        clock.getTime(),
      );
  db.sqlite
    .prepare(
      `INSERT INTO settings(id,user_id,created_at,updated_at) VALUES (?,?,?,?)`,
    )
    .run(
      '55555555-5555-4555-8555-555555555555',
      user,
      clock.getTime(),
      clock.getTime(),
    );
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const deps = () => ({ sqlite: db.sqlite, now: () => clock });
const input = {
  id: taskId,
  title: 'Math',
  subject: 'Algebra',
  defaultPomodoroTarget: 4,
  defaultTimerPreset: '50-10' as const,
  notes: null,
};
describe('versioned task service', () => {
  it('creates version 1 and an API-shaped upsert change atomically', () => {
    const result = createTaskService(deps()).create(user, input);
    expect(TaskSchema.parse(result).version).toBe(1);
    const change = db.sqlite
      .prepare('SELECT payload,version,change_type FROM sync_changes')
      .get() as { payload: string; version: number; change_type: string };
    expect(change).toMatchObject({ version: 1, change_type: 'upsert' });
    expect(TaskSchema.parse(JSON.parse(change.payload))).toEqual(result);
  });
  it('updates with expectedVersion and increments exactly once', () => {
    const service = createTaskService(deps());
    service.create(user, input);
    clock = new Date(clock.getTime() + 1);
    expect(
      service.update(user, taskId, { expectedVersion: 1, title: 'Calculus' }),
    ).toMatchObject({ title: 'Calculus', version: 2 });
    expect(
      db.sqlite.prepare('SELECT COUNT(*) n FROM sync_changes').get(),
    ).toEqual({ n: 2 });
  });
  it('rejects stale versions without entity or change-log mutation', () => {
    const service = createTaskService(deps());
    service.create(user, input);
    expect(() =>
      service.update(user, taskId, { expectedVersion: 2, title: 'No' }),
    ).toThrow(StaleVersionError);
    expect(service.get(user, taskId)).toMatchObject({
      title: 'Math',
      version: 1,
    });
    expect(
      db.sqlite.prepare('SELECT COUNT(*) n FROM sync_changes').get(),
    ).toEqual({ n: 1 });
  });
  it('archives, unarchives, then soft-deletes with consecutive versions', () => {
    const s = createTaskService(deps());
    s.create(user, input);
    expect(s.setArchived(user, taskId, 1, true)).toMatchObject({
      archived: true,
      version: 2,
    });
    expect(s.setArchived(user, taskId, 2, false)).toMatchObject({
      archived: false,
      version: 3,
    });
    expect(s.delete(user, taskId, 3)).toMatchObject({
      version: 4,
      deletedAt: clock.toISOString(),
    });
    expect(s.list(user, 'all')).toEqual([]);
    const change = db.sqlite
      .prepare(
        'SELECT change_type,payload FROM sync_changes ORDER BY cursor DESC LIMIT 1',
      )
      .get();
    expect(change).toEqual({ change_type: 'delete', payload: null });
  });
  it('isolates another user even when the id is known', () => {
    const s = createTaskService(deps());
    s.create(user, input);
    expect(s.get(other, taskId)).toBeNull();
    expect(() =>
      s.update(other, taskId, { expectedVersion: 1, title: 'stolen' }),
    ).toThrow('Entity not found');
  });
  it('rolls back entity creation if the change writer fails', () => {
    const s = createTaskService({
      ...deps(),
      writeChange: () => {
        throw new Error('change failed');
      },
    });
    expect(() => s.create(user, input)).toThrow('change failed');
    expect(db.sqlite.prepare('SELECT COUNT(*) n FROM tasks').get()).toEqual({
      n: 0,
    });
  });
});
describe('daily task and settings services', () => {
  it('adds a snapshot from a task that does not follow later source edits', () => {
    const t = createTaskService(deps());
    t.create(user, input);
    const d = createDailyTaskService(deps());
    const snapshot = d.addFromTask(user, taskId, {
      id: dailyId,
      date: '2026-07-13',
      sortOrder: 0,
    });
    t.update(user, taskId, { expectedVersion: 1, title: 'Changed' });
    expect(snapshot).toMatchObject({
      sourceTaskId: taskId,
      title: 'Math',
      pomodoroCompleted: 0,
      status: 'pending',
    });
    expect(d.list(user, '2026-07-13')[0]?.title).toBe('Math');
  });
  it('creates and edits a temporary daily task', () => {
    const d = createDailyTaskService(deps());
    const created = d.createTemporary(user, {
      id: dailyId,
      date: '2026-07-13',
      title: 'Essay',
      subject: 'English',
      pomodoroTarget: 2,
      timerPreset: '25-5',
      sortOrder: 3,
    });
    expect(DailyTaskSchema.parse(created).sourceTaskId).toBeNull();
    expect(
      d.update(user, dailyId, {
        expectedVersion: 1,
        sortOrder: 1,
        title: 'Reading',
      }),
    ).toMatchObject({ version: 2, title: 'Reading', sortOrder: 1 });
  });
  it('completes and restores without clearing pomodoroCompleted', () => {
    const d = createDailyTaskService(deps());
    d.createTemporary(user, {
      id: dailyId,
      date: '2026-07-13',
      title: 'Essay',
      subject: 'English',
      pomodoroTarget: 2,
      timerPreset: '25-5',
      sortOrder: 0,
    });
    db.sqlite
      .prepare('UPDATE daily_tasks SET pomodoro_completed=1 WHERE id=?')
      .run(dailyId);
    const complete = d.setCompleted(user, dailyId, 1, true);
    expect(complete).toMatchObject({
      status: 'completed',
      version: 2,
      pomodoroCompleted: 1,
      completedAt: clock.toISOString(),
    });
    expect(d.setCompleted(user, dailyId, 2, false)).toMatchObject({
      status: 'pending',
      version: 3,
      pomodoroCompleted: 1,
      completedAt: null,
    });
  });
  it('soft-deletes daily task with a null delete payload', () => {
    const d = createDailyTaskService(deps());
    d.createTemporary(user, {
      id: dailyId,
      date: '2026-07-13',
      title: 'Essay',
      subject: 'English',
      pomodoroTarget: 2,
      timerPreset: '25-5',
      sortOrder: 0,
    });
    d.delete(user, dailyId, 1);
    expect(d.list(user, '2026-07-13')).toEqual([]);
    expect(
      db.sqlite
        .prepare(
          'SELECT change_type,payload FROM sync_changes ORDER BY cursor DESC LIMIT 1',
        )
        .get(),
    ).toEqual({ change_type: 'delete', payload: null });
  });
  it('reads and updates settings with boundary-valid values and a schema payload', () => {
    const s = createSettingsService(deps());
    expect(SettingsSchema.parse(s.get(user)).version).toBe(1);
    const updated = s.update(user, {
      expectedVersion: 1,
      customFocusMinutes: 180,
      customShortBreakMinutes: 1,
      customLongBreakMinutes: 120,
      longBreakInterval: 12,
    });
    expect(updated.version).toBe(2);
    const payload = (
      db.sqlite.prepare('SELECT payload FROM sync_changes').get() as {
        payload: string;
      }
    ).payload;
    expect(SettingsSchema.parse(JSON.parse(payload))).toEqual(updated);
  });
  it('rolls back a settings update when change insertion fails', () => {
    const s = createSettingsService({
      ...deps(),
      writeChange: () => {
        throw new Error('fail');
      },
    });
    expect(() =>
      s.update(user, { expectedVersion: 1, soundEnabled: false }),
    ).toThrow('fail');
    expect(createSettingsService(deps()).get(user)).toMatchObject({
      version: 1,
      soundEnabled: true,
    });
  });
  it('uses continuous increasing change cursors', () => {
    const t = createTaskService(deps());
    t.create(user, input);
    t.setArchived(user, taskId, 1, true);
    expect(
      db.sqlite
        .prepare('SELECT cursor FROM sync_changes ORDER BY cursor')
        .all(),
    ).toEqual([{ cursor: 1 }, { cursor: 2 }]);
  });
});
