import type {
  OperationReceipt,
  PullChangesResponse,
} from '@kaoyan/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSyncDatabase, type SyncDatabase } from '../db/database';
import { replicaKey } from '../db/types';
import { FakeApiClient } from '../test/fake-api';
import {
  activeTimer,
  conflict,
  CONFLICT_ID,
  DAILY_ID,
  NOW,
  SETTINGS_ID,
  settings,
  session,
  TASK_ID,
  task,
  TIMER_ID,
  USER_A,
  USER_B,
} from '../test/fixtures';
import { AuthRequiredError, NetworkError } from './errors';
import { OfflineOperationQueue } from './queue';
import { SyncEngine } from './engine';

function receipt(
  operationId: string,
  status: 'applied' | 'duplicate' = 'applied',
  entityVersion = 1,
): OperationReceipt {
  return {
    operationId, status, entityVersion,
    conflictId: null, errorCode: null, errorMessage: null,
  };
}

function upsertTask(cursor: number, value = task()): PullChangesResponse {
  return {
    changes: [{
      cursor, entityType: 'task', entityId: value.id,
      version: value.version, changeType: 'upsert', payload: value,
      changedAt: NOW,
    }],
    nextCursor: cursor,
    hasMore: false,
  };
}

describe('synchronization engine', () => {
  let database: SyncDatabase;
  let queue: OfflineOperationQueue;
  let api: FakeApiClient;
  let engine: SyncEngine;
  beforeEach(async () => {
    database = createSyncDatabase(`engine-${crypto.randomUUID()}`);
    await database.open();
    queue = new OfflineOperationQueue(database, USER_A, {
      now: () => new Date(NOW),
    });
    api = new FakeApiClient();
    engine = new SyncEngine({ database, api, now: () => new Date(NOW) });
  });
  afterEach(async () => database.deleteDatabaseForTests());

  async function createLocalTask(id = TASK_ID) {
    return queue.createTask(id, {
      title: 'Calculus', subject: 'Math', defaultPomodoroTarget: 3,
      defaultTimerPreset: '25-5', notes: null,
    });
  }

  it('runs a complete empty cycle in the fixed order from cursor zero', async () => {
    await engine.start();
    expect(api.calls).toEqual(['session', 'pull:0', 'conflicts', 'timer']);
    expect(engine.status.getSnapshot().phase).toBe('synced');
  });

  it('pushes in sequence order and limits one cycle to 100 operations', async () => {
    const rows = [];
    for (let index = 0; index < 101; index += 1) {
      rows.push(await createLocalTask(
        `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ));
    }
    api.pushes.push({
      receipts: rows.slice(0, 100).map((row) => receipt(row.operationId)),
      latestCursor: 100,
    });
    await engine.manualSync();
    expect(api.pushedBatches[0]).toHaveLength(100);
    expect(api.pushedBatches[0]?.map((value) => value.operationId))
      .toEqual(rows.slice(0, 100).map((value) => value.operationId));
    expect(await database.countPendingOperations(USER_A)).toBe(1);
  });

  it('keeps the same operationId after a lost response, accepts duplicate, and cleans on pull', async () => {
    const row = await createLocalTask();
    api.pushes.push(new NetworkError());
    await engine.manualSync();
    expect((await database.operations.get(row.sequence ?? 0))?.state)
      .toBe('pending');
    api.pushes.push({ receipts: [receipt(row.operationId, 'duplicate')], latestCursor: 1 });
    api.pulls.push(upsertTask(1));
    await engine.manualSync();
    expect(api.pushedBatches[0]?.[0]?.operationId).toBe(row.operationId);
    expect(api.pushedBatches[1]?.[0]?.operationId).toBe(row.operationId);
    expect(await database.operations.count()).toBe(0);
    expect((await database.replicas.get(replicaKey(USER_A, 'task', TASK_ID)))
      ?.projectedValue).toEqual(task());
  });

  it('acknowledges applied operations but retains projection until pull covers the receipt', async () => {
    const row = await createLocalTask();
    api.pushes.push({ receipts: [receipt(row.operationId)], latestCursor: 7 });
    await engine.manualSync();
    expect((await database.operations.get(row.sequence ?? 0))?.state)
      .toBe('acknowledged');
    expect((await database.metadata.get(USER_A))?.cursor).toBe(0);
    expect(api.calls).toContain('pull:0');
  });

  it('stores rejected issues, removes their projection, and continues other receipts', async () => {
    const rejected = await createLocalTask(TASK_ID);
    const otherId = '00000000-0000-4000-8000-000000000099';
    const applied = await createLocalTask(otherId);
    api.pushes.push({
      receipts: [{
        operationId: rejected.operationId, status: 'rejected',
        entityVersion: null, conflictId: null,
        errorCode: 'INVALID', errorMessage: 'Rejected safely',
      }, receipt(applied.operationId)],
      latestCursor: 2,
    });
    await engine.manualSync();
    expect((await database.operations.get(rejected.sequence ?? 0))?.state)
      .toBe('rejected');
    expect((await database.operations.get(applied.sequence ?? 0))?.state)
      .toBe('acknowledged');
    expect(await database.syncIssues.where('operationId')
      .equals(rejected.operationId).first()).toMatchObject({
      errorCode: 'INVALID', operationId: rejected.operationId,
    });
    expect((await database.replicas.get(replicaKey(USER_A, 'task', TASK_ID)))
      ?.projectedValue).toBeNull();
  });

  it('treats a malformed receipt as protocol error without deleting the operation', async () => {
    const row = await createLocalTask();
    api.pushes.push({
      receipts: [{
        operationId: null, index: 0, status: 'rejected',
        entityVersion: null, conflictId: null,
        errorCode: 'MALFORMED_OPERATION', errorMessage: 'Operation is malformed',
      }],
      latestCursor: 0,
    });
    await engine.manualSync();
    expect((await database.operations.get(row.sequence ?? 0))?.state)
      .toBe('pending');
    expect(engine.status.getSnapshot()).toMatchObject({
      phase: 'error', lastErrorCode: 'PROTOCOL_ERROR',
    });
  });

  it('fetches conflict details and never retries conflict operations', async () => {
    const row = await createLocalTask();
    api.pushes.push({ receipts: [{
      operationId: row.operationId, status: 'conflict', entityVersion: 2,
      conflictId: CONFLICT_ID, errorCode: null, errorMessage: null,
    }], latestCursor: 2 });
    api.conflictDetails.set(CONFLICT_ID, conflict({
      localOperationId: row.operationId,
    }));
    await engine.manualSync();
    expect(api.calls).toContain(`conflict:${CONFLICT_ID}`);
    expect((await database.operations.get(row.sequence ?? 0))?.state)
      .toBe('conflict');
    await engine.manualSync();
    expect(api.pushedBatches).toHaveLength(1);
  });

  it('pulls all pages, validates payloads, and commits each cursor', async () => {
    api.pulls.push({ ...upsertTask(1), hasMore: true });
    api.pulls.push({
      changes: [{
        cursor: 2, entityType: 'settings', entityId: SETTINGS_ID,
        version: 1, changeType: 'upsert', payload: settings(), changedAt: NOW,
      }], nextCursor: 2, hasMore: false,
    });
    await engine.manualSync();
    expect(api.calls).toContain('pull:1');
    expect((await database.metadata.get(USER_A))?.cursor).toBe(2);
    expect(await database.replicas.count()).toBe(2);
  });

  it('keeps a delete tombstone instead of physically deleting a replica', async () => {
    api.pulls.push({ ...upsertTask(1), hasMore: true });
    api.pulls.push({
      changes: [{
        cursor: 2, entityType: 'task', entityId: TASK_ID,
        version: 2, changeType: 'delete', payload: null, changedAt: NOW,
      }], nextCursor: 2, hasMore: false,
    });
    await engine.manualSync();
    expect(await database.replicas.get(replicaKey(USER_A, 'task', TASK_ID)))
      .toMatchObject({ serverValue: null, projectedValue: null, serverVersion: 2 });
  });

  it('does not advance cursor for an invalid entity payload', async () => {
    api.pulls.push({
      changes: [{
        cursor: 1, entityType: 'task', entityId: TASK_ID, version: 1,
        changeType: 'upsert', payload: { id: TASK_ID }, changedAt: NOW,
      }], nextCursor: 1, hasMore: false,
    } as unknown as PullChangesResponse);
    await engine.manualSync();
    expect((await database.metadata.get(USER_A))?.cursor).toBe(0);
    expect(await database.replicas.count()).toBe(0);
    expect(engine.status.getSnapshot().lastErrorCode).toBe('PROTOCOL_ERROR');
  });

  it('rolls back the whole pull page and cursor when IndexedDB writing fails', async () => {
    database.replicas.hook('creating', () => {
      throw new Error('IndexedDB write failed');
    });
    api.pulls.push(upsertTask(1));
    await engine.manualSync();
    expect((await database.metadata.get(USER_A))?.cursor).toBe(0);
    expect(await database.replicas.count()).toBe(0);
    expect(engine.status.getSnapshot().phase).toBe('error');
  });

  it('reapplies pending local operations over newer pulled server values', async () => {
    await database.replicas.put({
      key: replicaKey(USER_A, 'task', TASK_ID), userId: USER_A,
      entityType: 'task', entityId: TASK_ID, serverValue: task(),
      projectedValue: task(), serverVersion: 1,
      pendingOperationIds: [], updatedLocallyAt: null,
    });
    const row = await queue.updateTask(TASK_ID, { title: 'Local title' });
    api.pushes.push({
      receipts: [receipt(row.operationId, 'applied', 3)], latestCursor: 1,
    });
    api.pulls.push(upsertTask(1, task({
      subject: 'Remote subject', version: 2,
    })));
    await engine.manualSync();
    expect((await database.replicas.get(replicaKey(USER_A, 'task', TASK_ID)))
      ?.projectedValue).toMatchObject({
        title: 'Local title', subject: 'Remote subject', version: 3,
      });
  });

  it('preserves queue and cursor when authentication expires', async () => {
    const row = await createLocalTask();
    await database.setActiveUser(USER_A);
    await database.metadata.update(USER_A, { cursor: 9 });
    api.sessions.push(new AuthRequiredError());
    await engine.manualSync();
    expect((await database.operations.get(row.sequence ?? 0))?.state)
      .toBe('pending');
    expect((await database.metadata.get(USER_A))?.cursor).toBe(9);
    expect(engine.status.getSnapshot().phase).toBe('authRequired');
  });

  it('resumes the same user queue after authentication', async () => {
    const row = await createLocalTask();
    await database.setActiveUser(USER_A);
    api.sessions.push(new AuthRequiredError());
    await engine.manualSync();
    api.sessions.push(session(USER_A));
    api.pushes.push({ receipts: [receipt(row.operationId)], latestCursor: 0 });
    await engine.resumeAfterAuthentication();
    expect(api.pushedBatches[0]?.[0]?.operationId).toBe(row.operationId);
  });

  it('does not synchronize while authentication is explicitly paused', async () => {
    engine.pauseForAuthentication();
    await engine.start();
    await engine.requestAutomaticSync();
    await engine.manualSync();
    expect(api.calls).toEqual([]);

    await engine.resumeAfterAuthentication();
    expect(api.calls[0]).toBe('session');
  });

  it('never uploads the previous user queue after a different user logs in', async () => {
    await createLocalTask();
    api.sessions.push(session(USER_B));
    await engine.manualSync();
    expect(api.pushedBatches).toHaveLength(0);
    expect(await database.countPendingOperations(USER_A)).toBe(1);
    expect((await database.metadata.get(USER_B))?.cursor).toBe(0);
  });

  it('calibrates timer clock offset and uncertainty at the response midpoint', async () => {
    const server = Date.parse(NOW);
    api.timers.push({
      data: { timer: activeTimer(), serverTime: NOW },
      requestStartedAt: server - 300,
      requestEndedAt: server - 100,
    });
    await engine.manualSync();
    expect(await database.timerCache.get(USER_A)).toMatchObject({
      serverTimer: { id: TIMER_ID },
      clockOffsetMs: 200,
      clockUncertaintyMs: 100,
    });
    expect(await database.metadata.get(USER_A)).toMatchObject({
      clockOffsetMs: 200, clockUncertaintyMs: 100,
    });
  });

  it('clears server timer on an activeTimer delete change', async () => {
    await database.timerCache.put({
      userId: USER_A, serverTimer: activeTimer(), projectedTimer: activeTimer(),
      serverTime: NOW, receivedAt: NOW, clockOffsetMs: 0,
      clockUncertaintyMs: 0, pendingOperationIds: [],
    });
    api.pulls.push({
      changes: [{
        cursor: 1, entityType: 'activeTimer', entityId: TIMER_ID,
        version: 2, changeType: 'delete', payload: null, changedAt: NOW,
      }], nextCursor: 1, hasMore: false,
    });
    await engine.manualSync();
    expect((await database.replicas.get(
      replicaKey(USER_A, 'activeTimer', TIMER_ID),
    ))?.serverValue).toBeNull();
  });

  it('retains a sync issue when a timer operation is rejected', async () => {
    const row = await queue.startTimer(TIMER_ID, {
      dailyTaskId: DAILY_ID, dailyTaskVersion: 1,
      phase: 'focus', plannedSeconds: 1500,
    });
    api.pushes.push({ receipts: [{
      operationId: row.operationId, status: 'rejected', entityVersion: null,
      conflictId: null, errorCode: 'TIMER_ALREADY_ACTIVE',
      errorMessage: 'Another timer is already active',
    }], latestCursor: 0 });
    await engine.manualSync();
    expect(await database.syncIssues.where('operationId')
      .equals(row.operationId).first()).toMatchObject({
        errorCode: 'TIMER_ALREADY_ACTIVE',
      });
    expect((await database.operations.get(row.sequence ?? 0))?.state)
      .toBe('rejected');
  });

  it('does not let an unrelated open conflict block pull', async () => {
    api.conflictLists.push([conflict()]);
    api.pulls.push(upsertTask(1));
    await engine.manualSync();
    expect((await database.metadata.get(USER_A))?.cursor).toBe(1);
    expect(await database.conflicts.count()).toBe(1);
  });

  it('coalesces multiple triggers during a cycle into one serial rerun', async () => {
    let release: ((value: ReturnType<typeof session>) => void) | undefined;
    const firstSession = new Promise<ReturnType<typeof session>>((resolve) => {
      release = resolve;
    });
    const sessionMethod = api.getCurrentSession.bind(api);
    let calls = 0;
    api.getCurrentSession = async () => {
      calls += 1;
      if (calls === 1) return firstSession;
      return sessionMethod();
    };
    const first = engine.manualSync();
    await Promise.resolve();
    const second = engine.requestAutomaticSync();
    const third = engine.manualSync();
    release?.(session());
    await Promise.all([first, second, third]);
    expect(calls).toBe(2);
  });

  it('pushes offline Task create, update, and archive with predicted server bases', async () => {
    const rows = [
      await createLocalTask(),
      await queue.updateTask(TASK_ID, { title: 'Limits' }),
      await queue.archiveTask(TASK_ID),
    ];
    api.pushes.push({
      receipts: rows.map((row, index) =>
        receipt(row.operationId, 'applied', index + 1)),
      latestCursor: 3,
    });
    await engine.manualSync();
    expect(api.pushedBatches[0]?.map((operation) => operation.baseVersion))
      .toEqual([0, 1, 2]);
    expect(await database.operations.where('state').equals('rejected').count())
      .toBe(0);
    expect(await database.operations.where('state').equals('acknowledged').count())
      .toBe(3);
  });

  it('pushes offline timer start and pause without stale timer versions', async () => {
    const rows = [
      await queue.startTimer(TIMER_ID, {
        dailyTaskId: DAILY_ID, dailyTaskVersion: 1,
        phase: 'focus', plannedSeconds: 1500,
      }),
      await queue.pauseTimer(TIMER_ID, 'Interruption'),
    ];
    api.pushes.push({
      receipts: rows.map((row, index) =>
        receipt(row.operationId, 'applied', index + 1)),
      latestCursor: 2,
    });
    await engine.manualSync();
    expect(api.pushedBatches[0]?.map((operation) => operation.baseVersion))
      .toEqual([0, 1]);
    expect(await database.operations.where('state').equals('rejected').count())
      .toBe(0);
  });

  it('updates cached conflicts to resolved without deleting them', async () => {
    api.conflictLists.push([conflict()]);
    await engine.manualSync();
    api.conflictLists.push([conflict({
      status: 'resolved', resolution: 'keepServer',
      resolutionResult: {
        resolutionRequest: { resolution: 'keepServer' }, affectedVersions: {},
      }, resolvedAt: NOW,
    })]);
    await engine.manualSync();
    const rows = await database.conflicts.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('resolved');
  });
});
