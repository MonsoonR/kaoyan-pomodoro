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
  it('rejects timer and focus operations stably', () => {
    const timer = op({
      entityType: 'activeTimer',
      operationType: 'timerStart',
      payload: { dailyTaskId: daily, phase: 'focus', plannedSeconds: 60 },
    });
    expect(processor().process(timer, user, device)).toMatchObject({
      status: 'rejected',
      errorCode: 'OPERATION_NOT_SUPPORTED',
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
    createConflictService(deps()).resolve(user, c.conflictId!, {
      resolution: 'restore',
    });
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
    createConflictService(deps()).resolve(user, conflict.conflictId!, {
      resolution: 'applyDelete',
    });
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
    const newId = '77777777-7777-4777-8777-777777777777';
    createConflictService(deps()).resolve(user, conflict.conflictId!, {
      resolution: 'copyAsNew',
      newEntityId: newId,
    });
    expect(createTaskService(deps()).get(user, newId)?.title).toBe('N');
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
    createConflictService(deps()).resolve(user, conflict.conflictId!, {
      resolution: 'complete',
    });
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
      conflictService.resolve(user, conflict.conflictId!, {
        resolution: resolutions[index]!,
      });
      expect(Boolean(dailyService.getAny(user, dailyId))).toBe(index > 0);
      expect(taskService.getAny(user, sourceId)?.archived).toBe(index < 2);
    }
  });
});
