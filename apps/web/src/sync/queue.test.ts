import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSyncDatabase, type SyncDatabase } from '../db/database';
import { replicaKey } from '../db/types';
import {
  DAILY_ID,
  SETTINGS_ID,
  settings,
  TASK_ID,
  TIMER_ID,
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
});
