import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSyncDatabase, type SyncDatabase } from '../db/database';
import { replicaKey } from '../db/types';
import {
  DAILY_ID,
  SETTINGS_ID,
  settings,
  TASK_ID,
  TIMER_ID,
  task,
  USER_A,
} from '../test/fixtures';
import { OfflineOperationQueue } from './queue';

describe('offline operation queue', () => {
  let database: SyncDatabase;
  let queue: OfflineOperationQueue;
  beforeEach(async () => {
    database = createSyncDatabase(`queue-${crypto.randomUUID()}`);
    await database.open();
    queue = new OfflineOperationQueue(database, USER_A);
  });
  afterEach(async () => database.deleteDatabaseForTests());

  const createPayload = {
    title: 'Calculus', subject: 'Math', defaultPomodoroTarget: 3,
    defaultTimerPreset: '25-5' as const, notes: null,
  };

  it('atomically writes an operation and optimistic replica', async () => {
    const row = await queue.createTask(TASK_ID, createPayload);
    expect(row.sequence).toBe(1);
    expect(await database.operations.count()).toBe(1);
    expect(await database.replicas.get(replicaKey(USER_A, 'task', TASK_ID)))
      .toMatchObject({
        projectedValue: { title: 'Calculus', version: 0 },
        pendingOperationIds: [row.operationId],
      });
  });

  it('rolls back every write when projection persistence fails', async () => {
    queue = new OfflineOperationQueue(database, USER_A, {
      beforeReplicaWrite: () => { throw new Error('write failed'); },
    });
    await expect(queue.createTask(TASK_ID, createPayload)).rejects
      .toThrow('write failed');
    expect(await database.operations.count()).toBe(0);
    expect(await database.replicas.count()).toBe(0);
    expect(await database.metadata.count()).toBe(0);
  });

  it('uses unique IDs and strictly increasing durable sequences', async () => {
    const first = await queue.createTask(TASK_ID, createPayload);
    const second = await queue.updateTask(TASK_ID, { title: 'Limits' });
    expect(first.operationId).not.toBe(second.operationId);
    expect(second.sequence).toBe((first.sequence ?? 0) + 1);
  });

  it('keeps the queue after database reload', async () => {
    const name = database.name;
    const row = await queue.createTask(TASK_ID, createPayload);
    database.close();
    database = createSyncDatabase(name);
    await database.open();
    expect((await database.operations.get(row.sequence ?? 0))?.operationId)
      .toBe(row.operationId);
  });

  it('projects create, update, archive and delete in order', async () => {
    await queue.createTask(TASK_ID, createPayload);
    await queue.updateTask(TASK_ID, { title: 'Limits' });
    await queue.archiveTask(TASK_ID);
    let replica = await database.replicas.get(replicaKey(USER_A, 'task', TASK_ID));
    expect(replica?.projectedValue).toMatchObject({
      title: 'Limits', archived: true, version: 2,
    });
    await queue.deleteTask(TASK_ID);
    replica = await database.replicas.get(replicaKey(USER_A, 'task', TASK_ID));
    expect(replica?.projectedValue).toBeNull();
  });

  it('projects daily create, update, complete and restore', async () => {
    await queue.createDailyTask(DAILY_ID, {
      sourceTaskId: null, date: '2026-07-13', title: 'Vocabulary',
      subject: 'English', pomodoroTarget: 2, timerPreset: '25-5', sortOrder: 0,
    });
    await queue.updateDailyTask(DAILY_ID, { pomodoroTarget: 3 });
    await queue.completeDailyTask(DAILY_ID);
    await queue.restoreDailyTask(DAILY_ID);
    expect((await database.replicas.get(
      replicaKey(USER_A, 'dailyTask', DAILY_ID),
    ))?.projectedValue).toMatchObject({
      pomodoroTarget: 3, status: 'pending', version: 3,
    });
  });

  it('projects settings only from a server replica', async () => {
    const value = settings();
    await database.replicas.put({
      key: replicaKey(USER_A, 'settings', SETTINGS_ID), userId: USER_A,
      entityType: 'settings', entityId: SETTINGS_ID,
      serverValue: value, projectedValue: value, serverVersion: 1,
      pendingOperationIds: [], updatedLocallyAt: null,
    });
    await queue.updateSettings(SETTINGS_ID, { soundEnabled: false });
    expect((await database.replicas.get(
      replicaKey(USER_A, 'settings', SETTINGS_ID),
    ))?.projectedValue).toMatchObject({ soundEnabled: false, version: 2 });
  });

  it('enqueues timer operations without fabricating server time', async () => {
    await queue.startTimer(TIMER_ID, {
      dailyTaskId: DAILY_ID, dailyTaskVersion: 1,
      phase: 'focus', plannedSeconds: 1500,
    });
    const cache = await database.timerCache.get(USER_A);
    expect(cache).toMatchObject({
      serverTime: null,
      projectedTimer: { id: TIMER_ID, status: 'starting', version: 0 },
    });
  });

  it('refuses client-created focus sessions', async () => {
    await expect(queue.enqueueOperation({
      entityType: 'focusSession', entityId: crypto.randomUUID(),
      operationType: 'create', baseVersion: 0,
      payload: {
        dailyTaskId: DAILY_ID, taskTitle: 'Task', subject: 'Math',
        phase: 'focus', plannedSeconds: 1500, effectiveSeconds: 100,
        startedAt: '2026-07-13T04:00:00.000Z',
        endedAt: '2026-07-13T04:01:40.000Z', result: 'completed',
        interruptionReason: null,
      },
    })).rejects.toThrow('cannot enqueue focus session');
    expect(await database.operations.count()).toBe(0);
  });

  it('isolates queues by user', async () => {
    await queue.createTask(TASK_ID, createPayload);
    expect(await database.countPendingOperations(USER_A)).toBe(1);
    expect(await database.countPendingOperations(
      '00000000-0000-4000-8000-000000000002',
    )).toBe(0);
  });

  it('predicts Task create, update, archive, and delete server bases', async () => {
    const rows = [
      await queue.createTask(TASK_ID, createPayload),
      await queue.updateTask(TASK_ID, { title: 'Limits' }),
      await queue.archiveTask(TASK_ID),
      await queue.deleteTask(TASK_ID),
    ];
    expect(rows.map((row) => row.operation.baseVersion))
      .toEqual([0, 1, 2, 3]);
  });

  it('predicts through an equal-value update without changing UI version', async () => {
    const value = task({ title: 'Calculus' });
    await database.replicas.put({
      key: replicaKey(USER_A, 'task', TASK_ID), userId: USER_A,
      entityType: 'task', entityId: TASK_ID,
      serverValue: value, projectedValue: value, serverVersion: 1,
      pendingOperationIds: [], updatedLocallyAt: null,
    });
    const update = await queue.updateTask(TASK_ID, { title: 'Calculus' });
    expect((await database.replicas.get(
      replicaKey(USER_A, 'task', TASK_ID),
    ))?.projectedValue).toMatchObject({ version: 1, archived: false });
    const archive = await queue.archiveTask(TASK_ID);
    expect(update.operation.baseVersion).toBe(1);
    expect(archive.operation.baseVersion).toBe(2);
    expect((await database.replicas.get(
      replicaKey(USER_A, 'task', TASK_ID),
    ))?.projectedValue).toMatchObject({ version: 2, archived: true });
    const afterUpdate = await database.operations.get(update.sequence ?? 0);
    expect(afterUpdate?.operation.baseVersion).toBe(1);
  });

  it('predicts DailyTask create, complete, restore, and delete server bases', async () => {
    const rows = [
      await queue.createDailyTask(DAILY_ID, {
        sourceTaskId: null, date: '2026-07-13', title: 'Vocabulary',
        subject: 'English', pomodoroTarget: 2,
        timerPreset: '25-5', sortOrder: 0,
      }),
      await queue.completeDailyTask(DAILY_ID),
      await queue.restoreDailyTask(DAILY_ID),
      await queue.deleteDailyTask(DAILY_ID),
    ];
    expect(rows.map((row) => row.operation.baseVersion))
      .toEqual([0, 1, 2, 3]);
  });

  it('predicts timer start, pause, resume, and exit server bases', async () => {
    const rows = [
      await queue.startTimer(TIMER_ID, {
        dailyTaskId: DAILY_ID, dailyTaskVersion: 1,
        phase: 'focus', plannedSeconds: 1500,
      }),
      await queue.pauseTimer(TIMER_ID, 'Break'),
      await queue.resumeTimer(TIMER_ID),
      await queue.exitTimer(TIMER_ID, 'Done'),
    ];
    expect(rows.map((row) => row.operation.baseVersion))
      .toEqual([0, 1, 2, 3]);
  });

  it('uses an acknowledged receipt version before pull arrives', async () => {
    const create = await queue.createTask(TASK_ID, createPayload);
    await database.operations.update(create.sequence ?? 0, {
      state: 'acknowledged',
      receipt: {
        operationId: create.operationId, status: 'applied', entityVersion: 1,
        conflictId: null, errorCode: null, errorMessage: null,
      },
    });
    const update = await queue.updateTask(TASK_ID, { title: 'Limits' });
    expect(update.operation.baseVersion).toBe(1);
  });

  it('combines acknowledged receipt versions with later pending operations', async () => {
    const create = await queue.createTask(TASK_ID, createPayload);
    await database.operations.update(create.sequence ?? 0, {
      state: 'acknowledged',
      receipt: {
        operationId: create.operationId, status: 'applied', entityVersion: 1,
        conflictId: null, errorCode: null, errorMessage: null,
      },
    });
    const update = await queue.updateTask(TASK_ID, { title: 'Limits' });
    const archive = await queue.archiveTask(TASK_ID);
    expect(update.operation.baseVersion).toBe(1);
    expect(archive.operation.baseVersion).toBe(2);
  });

  it('excludes rejected and conflict operations from version prediction', async () => {
    const value = task();
    await database.replicas.put({
      key: replicaKey(USER_A, 'task', TASK_ID), userId: USER_A,
      entityType: 'task', entityId: TASK_ID,
      serverValue: value, projectedValue: value, serverVersion: 1,
      pendingOperationIds: [], updatedLocallyAt: null,
    });
    const rejected = await queue.updateTask(TASK_ID, { title: 'Rejected' });
    await database.operations.update(rejected.sequence ?? 0, {
      state: 'rejected',
    });
    const conflicted = await queue.updateTask(TASK_ID, { title: 'Conflict' });
    await database.operations.update(conflicted.sequence ?? 0, {
      state: 'conflict',
    });
    const archive = await queue.archiveTask(TASK_ID);
    expect(conflicted.operation.baseVersion).toBe(1);
    expect(archive.operation.baseVersion).toBe(1);
  });

  it('predicts from persisted operations after IndexedDB restart', async () => {
    const name = database.name;
    await queue.createTask(TASK_ID, createPayload);
    await queue.updateTask(TASK_ID, { title: 'Limits' });
    database.close();
    database = createSyncDatabase(name);
    await database.open();
    queue = new OfflineOperationQueue(database, USER_A);
    const archive = await queue.archiveTask(TASK_ID);
    expect(archive.operation.baseVersion).toBe(2);
  });

  it('derives addToToday sourceTaskVersion from persisted predicted server state', async () => {
    const name = database.name;
    await queue.createTask(TASK_ID, createPayload);
    await queue.updateTask(TASK_ID, { title: 'Limits' });
    database.close();
    database = createSyncDatabase(name);
    await database.open();
    queue = new OfflineOperationQueue(database, USER_A);

    const added = await queue.addToToday(DAILY_ID, {
      sourceTaskId: TASK_ID,
      date: '2026-07-13',
      sortOrder: 0,
    });

    expect(added.operation).toMatchObject({
      operationType: 'addToToday',
      payload: { sourceTaskId: TASK_ID, sourceTaskVersion: 2 },
    });
  });
});
