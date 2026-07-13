import {
  DailyTaskSchema,
  SyncOperationSchema,
  TaskSchema,
} from '@kaoyan/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseConnection } from '../db/client';
import { migrateDatabase } from '../db/migrate';
import { createDailyTaskService } from '../services/daily-tasks';
import { createSettingsService } from '../services/settings';
import { createTaskService } from '../services/tasks';
import { createConflictService } from './conflicts';
import { pullChanges } from './pull';
import { createSyncProcessor } from './processor';
const user = '11111111-1111-4111-8111-111111111111',
  device = '22222222-2222-4222-8222-222222222222',
  task = '33333333-3333-4333-8333-333333333333',
  daily = '44444444-4444-4444-8444-444444444444',
  settingsId = '55555555-5555-4555-8555-555555555555';
let db: DatabaseConnection, dir: string, now: Date, ids: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-'));
  db = openDatabase(join(dir, 'db.sqlite'));
  migrateDatabase(db.db);
  now = new Date('2026-07-13T10:00:00Z');
  ids = 0;
  db.sqlite
    .prepare(
      `INSERT INTO users(id,singleton_key,username,password_hash,password_changed_at,created_at,updated_at)VALUES (?,1,'u','h',?,?,?)`,
    )
    .run(user, now.getTime(), now.getTime(), now.getTime());
  db.sqlite
    .prepare(
      `INSERT INTO devices(id,user_id,name,browser,operating_system,last_active_at,created_at,updated_at)VALUES (?,?,'d','b','o',?,?,?)`,
    )
    .run(device, user, now.getTime(), now.getTime(), now.getTime());
  db.sqlite
    .prepare(
      `INSERT INTO settings(id,user_id,created_at,updated_at)VALUES (?,?,?,?)`,
    )
    .run(settingsId, user, now.getTime(), now.getTime());
});

describe('server-managed timer synchronization', () => {
  const timerId = '66666666-6666-4666-8666-666666666666';
  const prepareDaily = () =>
    createDailyTaskService(deps()).createTemporary(user, {
      id: daily,
      date: '2026-07-13',
      title: 'Math today',
      subject: 'Algebra',
      pomodoroTarget: 1,
      timerPreset: '25-5',
      sortOrder: 0,
    });
  const timerOp = (
    operationType:
      | 'timerStart'
      | 'timerPause'
      | 'timerResume'
      | 'timerComplete'
      | 'timerExit',
    baseVersion: number,
    payload: Record<string, unknown>,
    entityId = timerId,
  ) =>
    op({
      entityId,
      entityType: 'activeTimer',
      operationType,
      baseVersion,
      payload,
    });

  it('syncs start, pause, resume and exit with duplicate and semantic retries', () => {
    prepareDaily();
    const p = processor();
    const started = timerOp('timerStart', 0, {
      dailyTaskId: daily,
      dailyTaskVersion: 1,
      phase: 'focus',
      plannedSeconds: 60,
    });
    expect(p.process(started, user, device)).toMatchObject({
      status: 'applied',
      entityVersion: 1,
    });
    expect(p.process(started, user, device)).toMatchObject({ status: 'duplicate' });
    expect(
      p.process(
        timerOp(
          'timerStart',
          0,
          {
            dailyTaskId: daily,
            dailyTaskVersion: 2,
            phase: 'focus',
            plannedSeconds: 60,
          },
          '67777777-7777-4777-8777-777777777777',
        ),
        user,
        device,
      ),
    ).toMatchObject({ status: 'rejected', errorCode: 'TIMER_ALREADY_ACTIVE' });
    now = new Date(now.getTime() + 10_000);
    expect(
      p.process(timerOp('timerPause', 1, { reason: 'Pause' }), user, device),
    ).toMatchObject({ status: 'applied', entityVersion: 2 });
    now = new Date(now.getTime() + 5_500);
    expect(
      p.process(timerOp('timerResume', 2, {}), user, device),
    ).toMatchObject({ status: 'applied', entityVersion: 3 });
    now = new Date(now.getTime() + 10_000);
    expect(
      p.process(timerOp('timerExit', 3, { reason: 'Stop' }), user, device),
    ).toMatchObject({ status: 'applied', entityVersion: 4 });
    const before = counts();
    expect(
      p.process(timerOp('timerExit', 4, { reason: 'Stop' }), user, device),
    ).toMatchObject({ status: 'applied', entityVersion: 4 });
    expect(counts()).toMatchObject({
      changes: before.changes,
      tasks: before.tasks,
      conflicts: before.conflicts,
    });
    expect(
      db.sqlite.prepare('SELECT count(*) n FROM focus_sessions').get(),
    ).toEqual({ n: 1 });
    const pulled = pullChanges(db.sqlite, user, 0, 100);
    expect(
      pulled.changes.some(
        (change) =>
          change.entityType === 'activeTimer' &&
          change.changeType === 'upsert' &&
          change.payload?.id === timerId,
      ),
    ).toBe(true);
    expect(
      pulled.changes.some(
        (change) =>
          change.entityType === 'activeTimer' &&
          change.changeType === 'delete' &&
          change.payload === null,
      ),
    ).toBe(true);
    expect(
      pulled.changes.some(
        (change) =>
          change.entityType === 'focusSession' &&
          change.changeType === 'upsert' &&
          change.payload?.id === timerId,
      ),
    ).toBe(true);
  });

  it('completes once across different operation ids and persists locked receipts', () => {
    prepareDaily();
    const p = processor();
    p.process(
      timerOp('timerStart', 0, {
        dailyTaskId: daily,
        dailyTaskVersion: 1,
        phase: 'focus',
        plannedSeconds: 60,
      }),
      user,
      device,
    );
    for (const operationType of ['complete', 'restore', 'delete'] as const) {
      const locked = op({
        entityId: daily,
        entityType: 'dailyTask',
        operationType,
        baseVersion: 2,
        payload: {},
      });
      expect(p.process(locked, user, device)).toMatchObject({
        status: 'rejected',
        errorCode: 'ACTIVE_TIMER_TASK_LOCKED',
      });
      expect(
        db.sqlite
          .prepare(
            'SELECT status,error_code FROM sync_operations WHERE operation_id=?',
          )
          .get(locked.operationId),
      ).toEqual({
        status: 'rejected',
        error_code: 'ACTIVE_TIMER_TASK_LOCKED',
      });
    }
    now = new Date(now.getTime() + 60_000);
    expect(
      p.process(timerOp('timerComplete', 1, {}), user, device),
    ).toMatchObject({ status: 'applied', entityVersion: 2 });
    const changeCount = counts().changes;
    expect(
      p.process(timerOp('timerComplete', 2, {}), user, device),
    ).toMatchObject({ status: 'applied', entityVersion: 2 });
    expect(counts().changes).toBe(changeCount);
    expect(db.sqlite.prepare('SELECT count(*) n FROM focus_sessions').get()).toEqual({ n: 1 });
  });

  it('rolls back timer state, task state and changes when receipt insertion fails', () => {
    prepareDaily();
    const before = counts();
    const failing = createSyncProcessor({
      ...deps(),
      writeReceipt: () => {
        throw new Error('receipt failed');
      },
    });
    expect(() =>
      failing.process(
        timerOp('timerStart', 0, {
          dailyTaskId: daily,
          dailyTaskVersion: 1,
          phase: 'focus',
          plannedSeconds: 60,
        }),
        user,
        device,
      ),
    ).toThrow('receipt failed');
    expect(counts()).toEqual(before);
    expect(
      db.sqlite.prepare('SELECT status,version FROM daily_tasks WHERE id=?').get(daily),
    ).toEqual({ status: 'pending', version: 1 });
    expect(db.sqlite.prepare('SELECT count(*) n FROM active_timer').get()).toEqual({ n: 0 });
  });

  it('rolls back terminal session, task, timer and changes when its receipt fails', () => {
    prepareDaily();
    processor().process(
      timerOp('timerStart', 0, {
        dailyTaskId: daily,
        dailyTaskVersion: 1,
        phase: 'focus',
        plannedSeconds: 60,
      }),
      user,
      device,
    );
    now = new Date(now.getTime() + 60_000);
    const before = counts();
    const failing = createSyncProcessor({
      ...deps(),
      writeReceipt: () => {
        throw new Error('terminal receipt failed');
      },
    });
    expect(() =>
      failing.process(timerOp('timerComplete', 1, {}), user, device),
    ).toThrow('terminal receipt failed');
    expect(counts()).toEqual(before);
    expect(
      db.sqlite
        .prepare(
          'SELECT status,pomodoro_completed,version FROM daily_tasks WHERE id=?',
        )
        .get(daily),
    ).toEqual({ status: 'active', pomodoro_completed: 0, version: 2 });
    expect(
      db.sqlite
        .prepare('SELECT version,deleted_at FROM active_timer WHERE id=?')
        .get(timerId),
    ).toEqual({ version: 1, deleted_at: null });
    expect(db.sqlite.prepare('SELECT count(*) n FROM focus_sessions').get()).toEqual({ n: 0 });
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const deps = () => ({
  sqlite: db.sqlite,
  now: () => now,
  generateId: () =>
    `aaaaaaaa-aaaa-4aaa-8aaa-${String(++ids).padStart(12, '0')}`,
});
const processor = () => createSyncProcessor(deps());
const op = (value: Record<string, unknown>) =>
  SyncOperationSchema.parse({
    operationId: `90000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    entityId: task,
    entityType: 'task',
    operationType: 'create',
    baseVersion: 0,
    payload: {
      title: 'Math',
      subject: 'Algebra',
      defaultPomodoroTarget: 4,
      defaultTimerPreset: '50-10',
      notes: null,
    },
    createdAt: now.toISOString(),
    ...value,
  });
const create = () =>
  op({
    entityType: 'task',
    operationType: 'create',
    payload: {
      title: 'Math',
      subject: 'Algebra',
      defaultPomodoroTarget: 4,
      defaultTimerPreset: '50-10',
      notes: null,
    },
  });
const counts = () => ({
  tasks: (
    db.sqlite.prepare('select count(*) n from tasks').get() as { n: number }
  ).n,
  changes: (
    db.sqlite.prepare('select count(*) n from sync_changes').get() as {
      n: number;
    }
  ).n,
  receipts: (
    db.sqlite.prepare('select count(*) n from sync_operations').get() as {
      n: number;
    }
  ).n,
  conflicts: (
    db.sqlite.prepare('select count(*) n from conflicts').get() as { n: number }
  ).n,
});
describe('idempotent processing', () => {
  it('applies task create and records receipt with one change', () => {
    expect(processor().process(create(), user, device)).toMatchObject({
      status: 'applied',
      entityVersion: 1,
    });
    expect(counts()).toEqual({
      tasks: 1,
      changes: 1,
      receipts: 1,
      conflicts: 0,
    });
  });
  it('returns duplicate without a second entity change', () => {
    const operation = create(),
      p = processor();
    p.process(operation, user, device);
    expect(p.process(operation, user, device)).toMatchObject({
      status: 'duplicate',
      entityVersion: 1,
    });
    expect(counts().changes).toBe(1);
  });
  it('rejects an existing entity id without overwriting', () => {
    const p = processor();
    p.process(create(), user, device);
    const second = create();
    expect(p.process(second, user, device)).toMatchObject({
      status: 'rejected',
      errorCode: 'ENTITY_ALREADY_EXISTS',
    });
    expect(createTaskService(deps()).get(user, task)?.title).toBe('Math');
  });
  it('replays the original rejected result without executing it again', () => {
    const p = processor();
    p.process(create(), user, device);
    const rejected = create();
    const first = p.process(rejected, user, device);
    expect(p.process(rejected, user, device)).toEqual(first);
    expect(counts().changes).toBe(1);
  });
  it('rolls back entity and change when receipt insertion fails', () => {
    const p = createSyncProcessor({
      ...deps(),
      writeReceipt: () => {
        throw new Error('receipt');
      },
    });
    expect(() => p.process(create(), user, device)).toThrow('receipt');
    expect(counts()).toEqual({
      tasks: 0,
      changes: 0,
      receipts: 0,
      conflicts: 0,
    });
  });
  it('applies timer operations and rejects client-created focus sessions', () => {
    createDailyTaskService(deps()).createTemporary(user, {
      id: daily,
      date: '2026-07-13',
      title: 'Math today',
      subject: 'Algebra',
      pomodoroTarget: 4,
      timerPreset: '50-10',
      sortOrder: 0,
    });
    const timer = op({
      entityId: '66666666-6666-4666-8666-666666666666',
      entityType: 'activeTimer',
      operationType: 'timerStart',
      payload: {
        dailyTaskId: daily,
        dailyTaskVersion: 1,
        phase: 'focus',
        plannedSeconds: 60,
      },
    });
    expect(processor().process(timer, user, device)).toMatchObject({
      status: 'applied',
      entityVersion: 1,
    });
    const focus = op({
      entityType: 'focusSession',
      operationType: 'create',
      payload: {
        dailyTaskId: daily,
        taskTitle: 'Forged',
        subject: 'Algebra',
        phase: 'focus',
        plannedSeconds: 60,
        effectiveSeconds: 60,
        startedAt: now.toISOString(),
        endedAt: now.toISOString(),
        result: 'completed',
        interruptionReason: null,
      },
    });
    expect(processor().process(focus, user, device)).toMatchObject({
      status: 'rejected',
      errorCode: 'SERVER_MANAGED_ENTITY',
    });
  });
  it('keeps earlier commits retry-safe after a later internal failure', () => {
    const first = create();
    processor().process(first, user, device);
    const failing = createSyncProcessor({
      ...deps(),
      writeReceipt: () => {
        throw new Error('middle failure');
      },
    });
    expect(() =>
      failing.process(
        op({ entityId: '77777777-7777-4777-8777-777777777777' }),
        user,
        device,
      ),
    ).toThrow('middle failure');
    expect(processor().process(first, user, device).status).toBe('duplicate');
  });
});
describe('last write wins and conflicts', () => {
  it('replays stale task patches on current version without overwriting omitted fields', () => {
    const p = processor();
    p.process(create(), user, device);
    p.process(
      op({
        entityType: 'task',
        operationType: 'update',
        baseVersion: 1,
        payload: { title: 'Calculus' },
      }),
      user,
      device,
    );
    const result = p.process(
      op({
        entityType: 'task',
        operationType: 'update',
        baseVersion: 1,
        payload: { subject: 'Geometry' },
      }),
      user,
      device,
    );
    expect(result.entityVersion).toBe(3);
    expect(createTaskService(deps()).get(user, task)).toMatchObject({
      title: 'Calculus',
      subject: 'Geometry',
      version: 3,
    });
    expect(counts().changes).toBe(3);
  });
  it('replays stale daily and settings patches', () => {
    const p = processor();
    const dailyCreate = op({
      entityId: daily,
      entityType: 'dailyTask',
      operationType: 'create',
      payload: {
        sourceTaskId: null,
        date: '2026-07-13',
        title: 'Essay',
        subject: 'English',
        pomodoroTarget: 2,
        timerPreset: '25-5',
        sortOrder: 0,
      },
    });
    p.process(dailyCreate, user, device);
    p.process(
      op({
        entityId: daily,
        entityType: 'dailyTask',
        operationType: 'update',
        baseVersion: 1,
        payload: { title: 'Read' },
      }),
      user,
      device,
    );
    expect(
      p.process(
        op({
          entityId: daily,
          entityType: 'dailyTask',
          operationType: 'update',
          baseVersion: 1,
          payload: { sortOrder: 2 },
        }),
        user,
        device,
      ).entityVersion,
    ).toBe(3);
    p.process(
      op({
        entityId: settingsId,
        entityType: 'settings',
        operationType: 'update',
        baseVersion: 1,
        payload: { soundEnabled: false },
      }),
      user,
      device,
    );
    expect(
      p.process(
        op({
          entityId: settingsId,
          entityType: 'settings',
          operationType: 'update',
          baseVersion: 1,
          payload: { customFocusMinutes: 60 },
        }),
        user,
        device,
      ).entityVersion,
    ).toBe(3);
    expect(createSettingsService(deps()).get(user)).toMatchObject({
      soundEnabled: false,
      customFocusMinutes: 60,
    });
  });
  it('creates delete_modify without entity change and retries same conflict', () => {
    const p = processor();
    p.process(create(), user, device);
    p.process(
      op({
        entityType: 'task',
        operationType: 'update',
        baseVersion: 1,
        payload: { title: 'New' },
      }),
      user,
      device,
    );
    const deletion = op({
      entityType: 'task',
      operationType: 'delete',
      baseVersion: 1,
      payload: {},
    });
    const first = p.process(deletion, user, device);
    expect(first).toMatchObject({ status: 'conflict', entityVersion: 2 });
    expect(createTaskService(deps()).get(user, task)?.deletedAt).toBeNull();
    expect(counts().changes).toBe(2);
    expect(p.process(deletion, user, device)).toEqual(first);
    expect(counts().conflicts).toBe(1);
  });
  it('creates complete_restore for opposite stale state', () => {
    const d = createDailyTaskService(deps());
    d.createTemporary(user, {
      id: daily,
      date: '2026-07-13',
      title: 'E',
      subject: 'S',
      pomodoroTarget: 1,
      timerPreset: '25-5',
      sortOrder: 0,
    });
    d.setCompleted(user, daily, 1, true);
    const restore = op({
      entityId: daily,
      entityType: 'dailyTask',
      operationType: 'restore',
      baseVersion: 1,
      payload: {},
    });
    expect(processor().process(restore, user, device)).toMatchObject({
      status: 'conflict',
    });
    expect(d.getAny(user, daily)?.status).toBe('completed');
  });
  it('creates archive_add_today for archived source', () => {
    const t = createTaskService(deps());
    t.create(user, {
      id: task,
      title: 'M',
      subject: 'S',
      defaultPomodoroTarget: 1,
      defaultTimerPreset: '25-5',
    });
    t.setArchived(user, task, 1, true);
    const add = op({
      entityId: daily,
      entityType: 'dailyTask',
      operationType: 'addToToday',
      payload: {
        sourceTaskId: task,
        sourceTaskVersion: 1,
        date: '2026-07-13',
        sortOrder: 0,
      },
    });
    expect(processor().process(add, user, device)).toMatchObject({
      status: 'conflict',
    });
    expect(createDailyTaskService(deps()).getAny(user, daily)).toBeNull();
  });
  it('rolls back conflict when receipt insertion fails', () => {
    const t = createTaskService(deps());
    t.create(user, {
      id: task,
      title: 'M',
      subject: 'S',
      defaultPomodoroTarget: 1,
      defaultTimerPreset: '25-5',
    });
    t.update(user, task, { expectedVersion: 1, title: 'N' });
    const p = createSyncProcessor({
      ...deps(),
      writeReceipt: () => {
        throw new Error('receipt');
      },
    });
    expect(() =>
      p.process(
        op({
          entityType: 'task',
          operationType: 'delete',
          baseVersion: 1,
          payload: {},
        }),
        user,
        device,
      ),
    ).toThrow('receipt');
    expect(counts().conflicts).toBe(0);
  });
});
describe('restore state and source task version semantics', () => {
  const createDailyInState = (
    status: 'pending' | 'active' | 'awaiting_confirmation' | 'completed',
  ) => {
    const service = createDailyTaskService(deps());
    service.createTemporary(user, {
      id: daily,
      date: '2026-07-13',
      title: 'Essay',
      subject: 'English',
      pomodoroTarget: 2,
      timerPreset: '25-5',
      sortOrder: 0,
    });
    if (status === 'completed') service.setCompleted(user, daily, 1, true);
    else if (status !== 'pending')
      db.sqlite
        .prepare('UPDATE daily_tasks SET status=? WHERE id=?')
        .run(status, daily);
    return service;
  };
  const restore = (baseVersion: number) =>
    processor().process(
      op({
        entityId: daily,
        entityType: 'dailyTask',
        operationType: 'restore',
        baseVersion,
        payload: {},
      }),
      user,
      device,
    );

  it('restores active to pending', () => {
    const service = createDailyInState('active');
    expect(restore(1)).toMatchObject({ status: 'applied', entityVersion: 2 });
    expect(service.getAny(user, daily)?.status).toBe('pending');
  });
  it('restores awaiting_confirmation to pending', () => {
    const service = createDailyInState('awaiting_confirmation');
    expect(restore(1)).toMatchObject({ status: 'applied', entityVersion: 2 });
    expect(service.getAny(user, daily)?.status).toBe('pending');
  });
  it('creates a conflict for stale active restore', () => {
    const service = createDailyInState('active');
    service.update(user, daily, { expectedVersion: 1, title: 'Changed' });
    expect(restore(1)).toMatchObject({ status: 'conflict', entityVersion: 2 });
    expect(service.getAny(user, daily)?.status).toBe('active');
  });
  it('creates a conflict for stale awaiting_confirmation restore', () => {
    const service = createDailyInState('awaiting_confirmation');
    service.update(user, daily, { expectedVersion: 1, title: 'Changed' });
    expect(restore(1)).toMatchObject({ status: 'conflict', entityVersion: 2 });
    expect(service.getAny(user, daily)?.status).toBe('awaiting_confirmation');
  });
  it('treats pending restore as idempotent without a version or change', () => {
    const service = createDailyInState('pending');
    const changes = counts().changes;
    expect(restore(1)).toMatchObject({ status: 'applied', entityVersion: 1 });
    expect(service.getAny(user, daily)).toMatchObject({
      status: 'pending',
      version: 1,
    });
    expect(counts().changes).toBe(changes);
  });
  it('restores completed to pending and increments its version', () => {
    const service = createDailyInState('completed');
    expect(restore(2)).toMatchObject({ status: 'applied', entityVersion: 3 });
    expect(service.getAny(user, daily)).toMatchObject({
      status: 'pending',
      version: 3,
    });
  });
  it('rejects addToToday when the source task is deleted', () => {
    const tasks = createTaskService(deps());
    tasks.create(user, {
      id: task,
      title: 'Math',
      subject: 'Algebra',
      defaultPomodoroTarget: 2,
      defaultTimerPreset: '25-5',
    });
    tasks.delete(user, task, 1);
    const result = processor().process(
      op({
        entityId: daily,
        entityType: 'dailyTask',
        operationType: 'addToToday',
        payload: {
          sourceTaskId: task,
          sourceTaskVersion: 1,
          date: '2026-07-13',
          sortOrder: 0,
        },
      }),
      user,
      device,
    );
    expect(result).toMatchObject({
      status: 'rejected',
      errorCode: 'SOURCE_TASK_DELETED',
    });
  });
  it('rejects an archived source when sourceTaskVersion is current', () => {
    const tasks = createTaskService(deps());
    tasks.create(user, {
      id: task,
      title: 'Math',
      subject: 'Algebra',
      defaultPomodoroTarget: 2,
      defaultTimerPreset: '25-5',
    });
    const archived = tasks.setArchived(user, task, 1, true);
    const result = processor().process(
      op({
        entityId: daily,
        entityType: 'dailyTask',
        operationType: 'addToToday',
        payload: {
          sourceTaskId: task,
          sourceTaskVersion: archived.version,
          date: '2026-07-13',
          sortOrder: 0,
        },
      }),
      user,
      device,
    );
    expect(result).toMatchObject({
      status: 'rejected',
      errorCode: 'SOURCE_TASK_ARCHIVED',
      entityVersion: 2,
    });
    expect(counts().conflicts).toBe(0);
  });
  it('creates archive_add_today only for a stale archived source', () => {
    const tasks = createTaskService(deps());
    tasks.create(user, {
      id: task,
      title: 'Math',
      subject: 'Algebra',
      defaultPomodoroTarget: 2,
      defaultTimerPreset: '25-5',
    });
    tasks.setArchived(user, task, 1, true);
    const result = processor().process(
      op({
        entityId: daily,
        entityType: 'dailyTask',
        operationType: 'addToToday',
        payload: {
          sourceTaskId: task,
          sourceTaskVersion: 1,
          date: '2026-07-13',
          sortOrder: 0,
        },
      }),
      user,
      device,
    );
    expect(result).toMatchObject({ status: 'conflict', entityVersion: 2 });
  });
  it('uses the current unarchived snapshot despite ordinary version drift', () => {
    const tasks = createTaskService(deps());
    tasks.create(user, {
      id: task,
      title: 'Math',
      subject: 'Algebra',
      defaultPomodoroTarget: 2,
      defaultTimerPreset: '25-5',
    });
    tasks.update(user, task, { expectedVersion: 1, title: 'Current title' });
    const result = processor().process(
      op({
        entityId: daily,
        entityType: 'dailyTask',
        operationType: 'addToToday',
        payload: {
          sourceTaskId: task,
          sourceTaskVersion: 1,
          date: '2026-07-13',
          sortOrder: 0,
        },
      }),
      user,
      device,
    );
    expect(result).toMatchObject({ status: 'applied', entityVersion: 1 });
    expect(createDailyTaskService(deps()).getAny(user, daily)?.title).toBe(
      'Current title',
    );
  });
});
describe('pull and resolution', () => {
  it('paginates cursor in order and validates payload schemas', () => {
    const t = createTaskService(deps());
    t.create(user, {
      id: task,
      title: 'M',
      subject: 'S',
      defaultPomodoroTarget: 1,
      defaultTimerPreset: '25-5',
    });
    t.setArchived(user, task, 1, true);
    const page = pullChanges(db.sqlite, user, 0, 1);
    expect(page).toMatchObject({ nextCursor: 1, hasMore: true });
    expect(TaskSchema.parse(page.changes[0]?.payload)).toBeTruthy();
    expect(pullChanges(db.sqlite, user, 1, 10)).toMatchObject({
      hasMore: false,
    });
    expect(pullChanges(db.sqlite, user, 99, 10)).toEqual({
      changes: [],
      nextCursor: 99,
      hasMore: false,
    });
  });
  it('returns delete payload null and validates other entity payloads', () => {
    const d = createDailyTaskService(deps());
    d.createTemporary(user, {
      id: daily,
      date: '2026-07-13',
      title: 'E',
      subject: 'S',
      pomodoroTarget: 1,
      timerPreset: '25-5',
      sortOrder: 0,
    });
    d.delete(user, daily, 1);
    const changes = pullChanges(db.sqlite, user, 0, 10).changes;
    expect(DailyTaskSchema.parse(changes[0]?.payload)).toBeTruthy();
    expect(changes[1]?.payload).toBeNull();
  });
  it('isolates pull by user and does not let an open conflict block changes', () => {
    const p = processor();
    p.process(create(), user, device);
    p.process(
      op({ operationType: 'update', baseVersion: 1, payload: { title: 'N' } }),
      user,
      device,
    );
    p.process(
      op({ operationType: 'delete', baseVersion: 1, payload: {} }),
      user,
      device,
    );
    expect(pullChanges(db.sqlite, user, 0, 10).changes).toHaveLength(2);
    expect(
      pullChanges(db.sqlite, '88888888-8888-4888-8888-888888888888', 0, 10)
        .changes,
    ).toEqual([]);
  });
  it('resolves delete_modify with keepServer and applyDelete idempotently', () => {
    const p = processor();
    p.process(create(), user, device);
    p.process(
      op({
        entityType: 'task',
        operationType: 'update',
        baseVersion: 1,
        payload: { title: 'N' },
      }),
      user,
      device,
    );
    const receipt = p.process(
      op({
        entityType: 'task',
        operationType: 'delete',
        baseVersion: 1,
        payload: {},
      }),
      user,
      device,
    );
    const service = createConflictService(deps());
    const id = receipt.conflictId!;
    expect(
      service.resolve(user, id, { resolution: 'keepServer' }).conflict.status,
    ).toBe('resolved');
    expect(
      service.resolve(user, id, { resolution: 'keepServer' }).affectedVersions,
    ).toEqual({});
  });
  it('resolves complete_restore and archive_add_today options', () => {
    const d = createDailyTaskService(deps());
    d.createTemporary(user, {
      id: daily,
      date: '2026-07-13',
      title: 'E',
      subject: 'S',
      pomodoroTarget: 1,
      timerPreset: '25-5',
      sortOrder: 0,
    });
    d.setCompleted(user, daily, 1, true);
    const c = processor().process(
      op({
        entityId: daily,
        entityType: 'dailyTask',
        operationType: 'restore',
        baseVersion: 1,
        payload: {},
      }),
      user,
      device,
    );
    const conflictService = createConflictService(deps());
    const first = conflictService.resolve(user, c.conflictId!, {
      resolution: 'restore',
    });
    expect(
      conflictService.resolve(user, c.conflictId!, { resolution: 'restore' }),
    ).toEqual(first);
    expect(d.getAny(user, daily)?.status).toBe('pending');
  });
  it('resolves delete_modify with applyDelete', () => {
    const p = processor();
    p.process(create(), user, device);
    p.process(
      op({ operationType: 'update', baseVersion: 1, payload: { title: 'N' } }),
      user,
      device,
    );
    const conflict = p.process(
      op({ operationType: 'delete', baseVersion: 1, payload: {} }),
      user,
      device,
    );
    const service = createConflictService(deps());
    const first = service.resolve(user, conflict.conflictId!, {
      resolution: 'applyDelete',
    });
    const afterFirst = counts();
    expect(
      service.resolve(user, conflict.conflictId!, { resolution: 'applyDelete' }),
    ).toEqual(first);
    expect(counts()).toEqual(afterFirst);
    expect(
      createTaskService(deps()).getAny(user, task)?.deletedAt,
    ).not.toBeNull();
  });
  it('resolves delete_modify with copyAsNew', () => {
    const p = processor();
    p.process(create(), user, device);
    p.process(
      op({ operationType: 'update', baseVersion: 1, payload: { title: 'N' } }),
      user,
      device,
    );
    const conflict = p.process(
      op({ operationType: 'delete', baseVersion: 1, payload: {} }),
      user,
      device,
    );
    const tasks = createTaskService(deps());
    tasks.update(user, task, {
      expectedVersion: 2,
      title: 'Version 3 title',
      subject: 'Version 3 subject',
      defaultPomodoroTarget: 7,
      defaultTimerPreset: 'custom',
      notes: 'Version 3 notes',
    });
    db.sqlite.prepare('UPDATE tasks SET archived=1 WHERE id=?').run(task);
    const newId = '77777777-7777-4777-8777-777777777777';
    const service = createConflictService(deps());
    const first = service.resolve(user, conflict.conflictId!, {
      resolution: 'copyAsNew',
      newEntityId: newId,
    });
    expect(first.affectedVersions).toEqual({ [newId]: 1, [task]: 4 });
    expect(tasks.get(user, newId)).toMatchObject({
      title: 'Version 3 title',
      subject: 'Version 3 subject',
      defaultPomodoroTarget: 7,
      defaultTimerPreset: 'custom',
      notes: 'Version 3 notes',
      archived: true,
    });
    expect(tasks.getAny(user, task)?.deletedAt).not.toBeNull();
    const resolutionChanges = db.sqlite
      .prepare(
        'SELECT entity_id,change_type FROM sync_changes ORDER BY cursor DESC LIMIT 2',
      )
      .all();
    expect(resolutionChanges).toEqual([
      { entity_id: task, change_type: 'delete' },
      { entity_id: newId, change_type: 'upsert' },
    ]);
    const afterFirst = counts();
    expect(
      service.resolve(user, conflict.conflictId!, {
        resolution: 'copyAsNew',
        newEntityId: newId,
      }),
    ).toEqual(first);
    expect(counts()).toEqual(afterFirst);
  });
  it('copies the resolution-time DailyTask state and progress before deleting it', () => {
    const dailyService = createDailyTaskService(deps());
    dailyService.createTemporary(user, {
      id: daily,
      date: '2026-07-13',
      title: 'Version 1',
      subject: 'English',
      pomodoroTarget: 2,
      timerPreset: '25-5',
      sortOrder: 0,
    });
    dailyService.update(user, daily, {
      expectedVersion: 1,
      title: 'Version 2',
    });
    const conflict = processor().process(
      op({
        entityId: daily,
        entityType: 'dailyTask',
        operationType: 'delete',
        baseVersion: 1,
        payload: {},
      }),
      user,
      device,
    );
    dailyService.update(user, daily, {
      expectedVersion: 2,
      title: 'Version 3',
      subject: 'Current subject',
      pomodoroTarget: 6,
      timerPreset: 'custom',
      sortOrder: 9,
    });
    db.sqlite
      .prepare(
        "UPDATE daily_tasks SET status='active',pomodoro_completed=3 WHERE id=?",
      )
      .run(daily);
    const newId = '78888888-7777-4777-8777-777777777777';
    const result = createConflictService(deps()).resolve(
      user,
      conflict.conflictId!,
      { resolution: 'copyAsNew', newEntityId: newId },
    );
    expect(result.affectedVersions).toEqual({ [newId]: 1, [daily]: 4 });
    expect(dailyService.getAny(user, newId)).toMatchObject({
      title: 'Version 3',
      subject: 'Current subject',
      pomodoroTarget: 6,
      pomodoroCompleted: 3,
      timerPreset: 'custom',
      status: 'active',
      sortOrder: 9,
      version: 1,
    });
    expect(dailyService.getAny(user, daily)).toMatchObject({
      version: 4,
    });
    expect(dailyService.getAny(user, daily)?.deletedAt).not.toBeNull();
  });
  it('copies an already-deleted final snapshot without another delete change', () => {
    const p = processor();
    p.process(create(), user, device);
    p.process(
      op({ operationType: 'update', baseVersion: 1, payload: { title: 'V2' } }),
      user,
      device,
    );
    const conflict = p.process(
      op({ operationType: 'delete', baseVersion: 1, payload: {} }),
      user,
      device,
    );
    const tasks = createTaskService(deps());
    tasks.update(user, task, { expectedVersion: 2, title: 'Final V3' });
    tasks.delete(user, task, 3);
    const changesBeforeResolution = counts().changes;
    const newId = '78999999-7777-4777-8777-777777777777';
    const result = createConflictService(deps()).resolve(
      user,
      conflict.conflictId!,
      { resolution: 'copyAsNew', newEntityId: newId },
    );
    expect(result.affectedVersions).toEqual({ [newId]: 1, [task]: 4 });
    expect(tasks.get(user, newId)?.title).toBe('Final V3');
    expect(counts().changes).toBe(changesBeforeResolution + 1);
    expect(
      db.sqlite
        .prepare(
          "SELECT count(*) count FROM sync_changes WHERE entity_id=? AND change_type='delete'",
        )
        .get(task),
    ).toEqual({ count: 1 });
  });
  it('rejects an occupied copyAsNew ID before modifying the source', () => {
    const p = processor();
    p.process(create(), user, device);
    p.process(
      op({ operationType: 'update', baseVersion: 1, payload: { title: 'N' } }),
      user,
      device,
    );
    const conflict = p.process(
      op({ operationType: 'delete', baseVersion: 1, payload: {} }),
      user,
      device,
    );
    const targetId = '79999999-7777-4777-8777-777777777777';
    const tasks = createTaskService(deps());
    tasks.create(user, {
      id: targetId,
      title: 'Occupied',
      subject: 'Existing',
      defaultPomodoroTarget: 1,
      defaultTimerPreset: '25-5',
    });
    tasks.delete(user, targetId, 1);
    const before = counts();
    try {
      createConflictService(deps()).resolve(user, conflict.conflictId!, {
        resolution: 'copyAsNew',
        newEntityId: targetId,
      });
      throw new Error('Expected target collision');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'CONFLICT_RESOLUTION_TARGET_EXISTS',
        entityId: targetId,
      });
    }
    expect(counts()).toEqual(before);
    expect(tasks.getAny(user, task)).toMatchObject({
      title: 'N',
      version: 2,
      deletedAt: null,
    });
    expect(
      db.sqlite
        .prepare(
          'SELECT status,resolution,resolution_result,resolved_at FROM conflicts WHERE id=?',
        )
        .get(conflict.conflictId!),
    ).toEqual({
      status: 'open',
      resolution: null,
      resolution_result: null,
      resolved_at: null,
    });
  });
  it('rejects an occupied archive_add_today target before modifying its source', () => {
    const sourceId = '71111111-7777-4777-8777-777777777777';
    const targetId = '72222222-7777-4777-8777-777777777777';
    const tasks = createTaskService(deps());
    tasks.create(user, {
      id: sourceId,
      title: 'Archived',
      subject: 'Existing',
      defaultPomodoroTarget: 1,
      defaultTimerPreset: '25-5',
    });
    tasks.setArchived(user, sourceId, 1, true);
    const conflict = processor().process(
      op({
        entityId: targetId,
        entityType: 'dailyTask',
        operationType: 'addToToday',
        payload: {
          sourceTaskId: sourceId,
          sourceTaskVersion: 1,
          date: '2026-07-13',
          sortOrder: 0,
        },
      }),
      user,
      device,
    );
    const dailyService = createDailyTaskService(deps());
    dailyService.createTemporary(user, {
      id: targetId,
      date: '2026-07-13',
      title: 'Occupied target',
      subject: 'Existing',
      pomodoroTarget: 1,
      timerPreset: '25-5',
      sortOrder: 0,
    });
    dailyService.delete(user, targetId, 1);
    const before = counts();
    try {
      createConflictService(deps()).resolve(user, conflict.conflictId!, {
        resolution: 'unarchiveAndAdd',
      });
      throw new Error('Expected target collision');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'CONFLICT_RESOLUTION_TARGET_EXISTS',
        entityId: targetId,
      });
    }
    expect(counts()).toEqual(before);
    expect(tasks.getAny(user, sourceId)).toMatchObject({
      archived: true,
      version: 2,
    });
    expect(
      db.sqlite
        .prepare(
          'SELECT status,resolution_result FROM conflicts WHERE id=?',
        )
        .get(conflict.conflictId!),
    ).toEqual({ status: 'open', resolution_result: null });
  });
  it('rolls back entity and changes when saving the resolution result fails', () => {
    const p = processor();
    p.process(create(), user, device);
    p.process(
      op({ operationType: 'update', baseVersion: 1, payload: { title: 'N' } }),
      user,
      device,
    );
    const conflict = p.process(
      op({ operationType: 'delete', baseVersion: 1, payload: {} }),
      user,
      device,
    );
    const before = counts();
    const service = createConflictService({
      ...deps(),
      writeResolutionResult: (sqlite) => {
        expect(
          (sqlite
            .prepare('SELECT deleted_at FROM tasks WHERE id=?')
            .get(task) as { deleted_at: number | null }).deleted_at,
        ).not.toBeNull();
        expect(
          sqlite
            .prepare(
              'SELECT status,resolution,resolution_result FROM conflicts WHERE id=?',
            )
            .get(conflict.conflictId!),
        ).toEqual({
          status: 'open',
          resolution: null,
          resolution_result: null,
        });
        throw new Error('resolution result write failed');
      },
    });
    expect(() =>
      service.resolve(user, conflict.conflictId!, { resolution: 'applyDelete' }),
    ).toThrow('resolution result write failed');
    expect(counts()).toEqual(before);
    expect(createTaskService(deps()).getAny(user, task)?.deletedAt).toBeNull();
    expect(
      db.sqlite
        .prepare(
          'SELECT status,resolution,resolution_result,resolved_at FROM conflicts WHERE id=?',
        )
        .get(conflict.conflictId!),
    ).toEqual({
      status: 'open',
      resolution: null,
      resolution_result: null,
      resolved_at: null,
    });
  });
  it('resolves complete_restore with complete', () => {
    const d = createDailyTaskService(deps());
    d.createTemporary(user, {
      id: daily,
      date: '2026-07-13',
      title: 'E',
      subject: 'S',
      pomodoroTarget: 1,
      timerPreset: '25-5',
      sortOrder: 0,
    });
    const changed = d.update(user, daily, {
      expectedVersion: 1,
      title: 'Changed',
    });
    const conflict = processor().process(
      op({
        entityId: daily,
        entityType: 'dailyTask',
        operationType: 'complete',
        baseVersion: 1,
        payload: {},
      }),
      user,
      device,
    );
    expect(changed.version).toBe(2);
    const service = createConflictService(deps());
    const first = service.resolve(user, conflict.conflictId!, {
      resolution: 'complete',
    });
    expect(
      service.resolve(user, conflict.conflictId!, { resolution: 'complete' }),
    ).toEqual(first);
    expect(d.getAny(user, daily)?.status).toBe('completed');
  });
  it('resolves archive_add_today with keepArchived, addAnyway, and unarchiveAndAdd', () => {
    const taskService = createTaskService(deps());
    const dailyService = createDailyTaskService(deps());
    const conflictService = createConflictService(deps());
    const resolutions = [
      'keepArchived',
      'addAnyway',
      'unarchiveAndAdd',
    ] as const;
    for (let index = 0; index < resolutions.length; index++) {
      const sourceId = `61000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const dailyId = `62000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      taskService.create(user, {
        id: sourceId,
        title: 'M',
        subject: 'S',
        defaultPomodoroTarget: 1,
        defaultTimerPreset: '25-5',
      });
      taskService.setArchived(user, sourceId, 1, true);
      const conflict = processor().process(
        op({
          entityId: dailyId,
          entityType: 'dailyTask',
          operationType: 'addToToday',
          payload: {
            sourceTaskId: sourceId,
            sourceTaskVersion: 1,
            date: '2026-07-13',
            sortOrder: index,
          },
        }),
        user,
        device,
      );
      const first = conflictService.resolve(user, conflict.conflictId!, {
        resolution: resolutions[index]!,
      });
      expect(
        conflictService.resolve(user, conflict.conflictId!, {
          resolution: resolutions[index]!,
        }),
      ).toEqual(first);
      expect(Boolean(dailyService.getAny(user, dailyId))).toBe(index > 0);
      expect(taskService.getAny(user, sourceId)?.archived).toBe(index < 2);
    }
  });
});
