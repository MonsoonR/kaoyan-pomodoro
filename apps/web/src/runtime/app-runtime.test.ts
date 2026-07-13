import type {
  PullChangesResponse,
  PushOperationsResponse,
  SyncOperation,
} from '@kaoyan/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncDatabase, type SyncDatabase } from '../db/database';
import { replicaKey } from '../db/types';
import { SyncEngine } from '../sync/engine';
import { NOW, session, TASK_ID, USER_A } from '../test/fixtures';
import { FakeApiClient } from '../test/fake-api';
import { AuthRequiredError, NetworkError } from '../sync/errors';
import { SyncStatusStore } from '../sync/status';
import { AppRuntime } from './app-runtime';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function activeSessionRecovery(runtime: AppRuntime): Promise<void> {
  const recovery = Reflect.get(runtime, 'sessionRecoveryPromise') as
    Promise<void> | null;
  if (!recovery) throw new Error('Expected an active session recovery');
  return recovery;
}

function accountApi() {
  return Object.assign(new FakeApiClient(), {
    login: vi.fn(async () => session()),
    logout: vi.fn(async () => ({ ok: true as const })),
  });
}

describe('application runtime lifecycle', () => {
  const databases: SyncDatabase[] = [];
  afterEach(async () => {
    for (const database of databases.splice(0))
      await database.deleteDatabaseForTests();
  });

  function runtimeWith(
    database: SyncDatabase,
    getCurrentSession: () => Promise<ReturnType<typeof session>>,
    loginSession = session(),
  ) {
    const status = new SyncStatusStore();
    const resumeAfterAuthentication = vi.fn(async () => undefined);
    const pauseForAuthentication = vi.fn();
    const api = {
      getCurrentSession: vi.fn(getCurrentSession),
      login: vi.fn(async () => loginSession),
      logout: vi.fn(async () => ({ ok: true as const })),
    };
    const scheduler = { start: vi.fn(), stop: vi.fn() };
    const runtime = new AppRuntime({
      database,
      api: api as never,
      engine: {
        status, resumeAfterAuthentication, pauseForAuthentication,
      } as never,
      scheduler,
    });
    return {
      runtime, api, status, scheduler,
      resumeAfterAuthentication, pauseForAuthentication,
    };
  }

  it('opens and starts only once across repeated StrictMode-style leases', async () => {
    const open = vi.fn(async () => undefined);
    const close = vi.fn();
    const start = vi.fn();
    const stop = vi.fn();
    const runtime = new AppRuntime({
      database: { open, close, getActiveUserId: async () => null } as never,
      api: {} as never,
      engine: { status: { subscribe: () => () => {}, getSnapshot: () => ({ phase: 'idle' }) } } as never,
      scheduler: { start, stop } as never,
    });

    const releaseFirst = runtime.acquire();
    const releaseSecond = runtime.acquire();
    await runtime.ready();
    expect(open).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(stop).not.toHaveBeenCalled();
    releaseSecond();
    await runtime.closed();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('opens an existing active replica offline but blocks offline first login', async () => {
    const existing = createSyncDatabase(`runtime-offline-${crypto.randomUUID()}`);
    databases.push(existing);
    await existing.open();
    await existing.setActiveUser(USER_A);
    existing.close();
    const local = runtimeWith(existing, async () => { throw new NetworkError(); });
    const releaseLocal = local.runtime.acquire();
    await local.runtime.ready();
    expect(local.runtime.getSnapshot()).toMatchObject({
      authMode: 'offline', activeUserId: USER_A, firstLoginOffline: false,
    });
    releaseLocal();
    await local.runtime.closed();

    const fresh = createSyncDatabase(`runtime-first-${crypto.randomUUID()}`);
    databases.push(fresh);
    const first = runtimeWith(fresh, async () => { throw new NetworkError(); });
    const releaseFirst = first.runtime.acquire();
    await first.runtime.ready();
    expect(first.runtime.getSnapshot()).toMatchObject({
      authMode: 'login', activeUserId: null, firstLoginOffline: true,
    });
    releaseFirst();
    await first.runtime.closed();
  });

  it('retains operation identity and projection through 401, login, and logout', async () => {
    const database = createSyncDatabase(`runtime-reauth-${crypto.randomUUID()}`);
    databases.push(database);
    await database.open();
    await database.setActiveUser(USER_A);
    const queue = new (await import('../sync/queue')).OfflineOperationQueue(
      database,
      USER_A,
      { now: () => new Date(NOW) },
    );
    const operation = await queue.createTask(TASK_ID, {
      title: 'Retained task', subject: 'Math', defaultPomodoroTarget: 2,
      defaultTimerPreset: '25-5', notes: null,
    });
    database.close();
    const setup = runtimeWith(database, async () => {
      throw new AuthRequiredError();
    });
    const release = setup.runtime.acquire();
    await setup.runtime.ready();
    expect(setup.runtime.getSnapshot().authMode).toBe('authRequired');

    await setup.runtime.login('learner', 'secure password');
    expect(setup.resumeAfterAuthentication).toHaveBeenCalledTimes(1);
    await setup.runtime.logout();
    expect(setup.runtime.getSnapshot().authMode).toBe('authRequired');
    const retained = await database.operations.get(operation.sequence ?? 0);
    expect(retained?.operationId).toBe(operation.operationId);
    expect((await database.replicas.get(
      replicaKey(USER_A, 'task', TASK_ID),
    ))?.projectedValue).toMatchObject({ title: 'Retained task' });
    release();
    await setup.runtime.closed();
  });

  it('keeps persisted authRequired authoritative across an offline restart', async () => {
    const database = createSyncDatabase(`runtime-required-${crypto.randomUUID()}`);
    databases.push(database);
    await database.open();
    await database.setActiveUser(USER_A);
    await database.metadata.update(USER_A, {
      authState: 'required',
      username: 'learner',
      deviceId: '00000000-0000-4000-8000-000000000003',
      deviceName: 'Laptop',
      sessionExpiresAt: '2026-07-14T04:00:00.000Z',
      cursor: 7,
    });
    const queue = new (await import('../sync/queue')).OfflineOperationQueue(
      database,
      USER_A,
      { now: () => new Date(NOW) },
    );
    const operation = await queue.createTask(TASK_ID, {
      title: 'Persisted task', subject: 'Math', defaultPomodoroTarget: 2,
      defaultTimerPreset: '25-5', notes: null,
    });
    database.close();

    const setup = runtimeWith(database, async () => { throw new NetworkError(); });
    const release = setup.runtime.acquire();
    await setup.runtime.ready();

    expect(setup.runtime.getSnapshot()).toMatchObject({
      authMode: 'authRequired', activeUserId: USER_A,
      username: 'learner', session: null,
    });
    expect(setup.api.getCurrentSession).not.toHaveBeenCalled();
    expect(setup.pauseForAuthentication).toHaveBeenCalledTimes(1);
    expect(setup.scheduler.start).toHaveBeenCalledTimes(1);
    setup.status.update({ phase: 'offline' });
    expect(setup.runtime.getSnapshot().authMode).toBe('authRequired');
    expect((await database.operations.get(operation.sequence ?? 0))?.operationId)
      .toBe(operation.operationId);
    expect((await database.replicas.get(replicaKey(USER_A, 'task', TASK_ID)))
      ?.projectedValue).toMatchObject({ title: 'Persisted task' });
    expect((await database.metadata.get(USER_A))?.cursor).toBe(7);

    await setup.runtime.login('learner', 'secure password');
    expect(setup.resumeAfterAuthentication).toHaveBeenCalledTimes(1);
    expect((await database.operations.get(operation.sequence ?? 0))?.operationId)
      .toBe(operation.operationId);
    release();
    await setup.runtime.closed();
  });

  it('keeps logout authoritative when the same database restarts offline', async () => {
    const database = createSyncDatabase(`runtime-logout-${crypto.randomUUID()}`);
    databases.push(database);
    const first = runtimeWith(database, async () => session());
    const releaseFirst = first.runtime.acquire();
    await first.runtime.ready();
    const operation = await first.runtime.queueFor(USER_A).createTask(TASK_ID, {
      title: 'Logged-out task', subject: 'Math', defaultPomodoroTarget: 2,
      defaultTimerPreset: '25-5', notes: null,
    });
    await first.runtime.logout();
    releaseFirst();
    await first.runtime.closed();

    const restarted = runtimeWith(database, async () => { throw new NetworkError(); });
    const releaseRestarted = restarted.runtime.acquire();
    await restarted.runtime.ready();
    expect(restarted.runtime.getSnapshot()).toMatchObject({
      authMode: 'authRequired', activeUserId: USER_A, session: null,
    });
    expect((await database.operations.get(operation.sequence ?? 0))?.operationId)
      .toBe(operation.operationId);
    expect((await database.replicas.get(replicaKey(USER_A, 'task', TASK_ID)))
      ?.projectedValue).toMatchObject({ title: 'Logged-out task' });
    releaseRestarted();
    await restarted.runtime.closed();
  });

  it('restores and refreshes a persisted session after offline startup recovers', async () => {
    const database = createSyncDatabase(`runtime-recovery-${crypto.randomUUID()}`);
    databases.push(database);
    await database.open();
    await database.setActiveUser(USER_A);
    const persisted = session();
    await database.metadata.update(USER_A, {
      authState: 'authenticated',
      username: persisted.user.username,
      deviceId: persisted.deviceId,
      deviceName: 'Old laptop name',
      sessionExpiresAt: persisted.expiresAt,
    });
    database.close();
    const refreshed = {
      ...persisted,
      deviceName: 'Renamed laptop',
      expiresAt: '2026-07-15T04:00:00.000Z',
    };
    let request = 0;
    const setup = runtimeWith(database, async () => {
      request += 1;
      if (request === 1) throw new NetworkError();
      return refreshed;
    });
    const open = vi.spyOn(database, 'open');
    const release = setup.runtime.acquire();
    await setup.runtime.ready();
    expect(setup.runtime.getSnapshot()).toMatchObject({
      authMode: 'offline', session: {
        deviceName: 'Old laptop name', expiresAt: persisted.expiresAt,
      },
    });

    setup.status.update({ phase: 'synced' });
    await vi.waitFor(() => {
      expect(setup.runtime.getSnapshot()).toMatchObject({
        authMode: 'authenticated', session: refreshed,
      });
    });
    expect(await database.metadata.get(USER_A)).toMatchObject({
      authState: 'authenticated',
      username: refreshed.user.username,
      deviceId: refreshed.deviceId,
      deviceName: refreshed.deviceName,
      sessionExpiresAt: refreshed.expiresAt,
    });
    expect(setup.scheduler.start).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    release();
    await setup.runtime.closed();
  });

  it('requires authentication when recovery validation returns 401', async () => {
    const database = createSyncDatabase(`runtime-recovery-401-${crypto.randomUUID()}`);
    databases.push(database);
    await database.open();
    await database.setActiveUser(USER_A);
    const persisted = session();
    await database.metadata.update(USER_A, {
      authState: 'authenticated', username: persisted.user.username,
      deviceId: persisted.deviceId, deviceName: persisted.deviceName,
      sessionExpiresAt: persisted.expiresAt, cursor: 11,
    });
    const operation = await new (await import('../sync/queue')).OfflineOperationQueue(
      database,
      USER_A,
      { now: () => new Date(NOW) },
    ).createTask(TASK_ID, {
      title: '401 retained task', subject: 'Math', defaultPomodoroTarget: 2,
      defaultTimerPreset: '25-5', notes: null,
    });
    database.close();
    let request = 0;
    const setup = runtimeWith(database, async () => {
      request += 1;
      if (request === 1) throw new NetworkError();
      throw new AuthRequiredError();
    });
    const release = setup.runtime.acquire();
    await setup.runtime.ready();
    setup.status.update({ phase: 'synced' });
    await vi.waitFor(() => {
      expect(setup.runtime.getSnapshot()).toMatchObject({
        authMode: 'authRequired', session: null,
      });
    });
    expect((await database.operations.get(operation.sequence ?? 0))?.operationId)
      .toBe(operation.operationId);
    expect((await database.replicas.get(replicaKey(USER_A, 'task', TASK_ID)))
      ?.projectedValue).toMatchObject({ title: '401 retained task' });
    expect((await database.metadata.get(USER_A))?.cursor).toBe(11);
    release();
    await setup.runtime.closed();
  });

  it.each([
    ['old session', 'session'],
    ['old 401', 'authRequired'],
    ['old network failure', 'network'],
  ] as const)('discards %s after a newer explicit login', async (_label, result) => {
    const database = createSyncDatabase(`runtime-stale-recovery-${result}-${crypto.randomUUID()}`);
    databases.push(database);
    const oldSession = {
      ...session(), deviceName: 'Old revoked device',
      expiresAt: '2026-07-14T04:00:00.000Z',
    };
    const newSession = {
      ...session(), deviceName: 'New login device',
      expiresAt: '2026-07-18T04:00:00.000Z',
    };
    const recovery = deferred<ReturnType<typeof session>>();
    let requestCount = 0;
    const setup = runtimeWith(database, async () => {
      requestCount += 1;
      return requestCount === 1 ? oldSession : recovery.promise;
    }, newSession);
    const release = setup.runtime.acquire();
    await setup.runtime.ready();
    setup.status.update({ phase: 'synced' });
    await vi.waitFor(() => {
      expect(setup.api.getCurrentSession).toHaveBeenCalledTimes(2);
    });
    const recoveryWork = activeSessionRecovery(setup.runtime);

    await setup.runtime.logout();
    expect(setup.runtime.getSnapshot().authMode).toBe('authRequired');
    await setup.runtime.login('learner', 'secure password');
    expect(setup.runtime.getSnapshot()).toMatchObject({
      authMode: 'authenticated', session: newSession,
    });
    expect(await database.metadata.get(USER_A)).toMatchObject({
      authState: 'authenticated',
      deviceName: newSession.deviceName,
      sessionExpiresAt: newSession.expiresAt,
    });

    if (result === 'session') recovery.resolve(oldSession);
    else if (result === 'authRequired') recovery.reject(new AuthRequiredError());
    else recovery.reject(new NetworkError());
    await recoveryWork;

    expect(setup.runtime.getSnapshot()).toMatchObject({
      authMode: 'authenticated', session: newSession,
    });
    expect(await database.metadata.get(USER_A)).toMatchObject({
      authState: 'authenticated',
      deviceName: newSession.deviceName,
      sessionExpiresAt: newSession.expiresAt,
    });
    expect(setup.pauseForAuthentication).toHaveBeenCalledTimes(1);
    release();
    await setup.runtime.closed();
  });

  it('keeps authRequired when a newer login attempt fails before old recovery returns', async () => {
    const database = createSyncDatabase(`runtime-stale-recovery-login-failure-${crypto.randomUUID()}`);
    databases.push(database);
    const oldSession = {
      ...session(), deviceName: 'Old recovery after failed login',
    };
    const recovery = deferred<ReturnType<typeof session>>();
    let requestCount = 0;
    const setup = runtimeWith(database, async () => {
      requestCount += 1;
      return requestCount === 1 ? session() : recovery.promise;
    });
    const release = setup.runtime.acquire();
    await setup.runtime.ready();
    setup.status.update({ phase: 'synced' });
    await vi.waitFor(() => {
      expect(setup.api.getCurrentSession).toHaveBeenCalledTimes(2);
    });
    const recoveryWork = activeSessionRecovery(setup.runtime);
    await setup.runtime.logout();
    setup.api.login.mockRejectedValue(new NetworkError());

    await expect(setup.runtime.login('learner', 'secure password'))
      .rejects.toBeInstanceOf(NetworkError);
    recovery.resolve(oldSession);
    await recoveryWork;

    expect(setup.runtime.getSnapshot()).toMatchObject({
      authMode: 'authRequired', session: null,
    });
    expect(await database.metadata.get(USER_A)).toMatchObject({
      authState: 'required',
    });
    release();
    await setup.runtime.closed();
  });

  it('does not commit a session recovery after disposal', async () => {
    const database = createSyncDatabase(`runtime-stale-recovery-dispose-${crypto.randomUUID()}`);
    databases.push(database);
    const current = session();
    const recovery = deferred<ReturnType<typeof session>>();
    let requestCount = 0;
    const setup = runtimeWith(database, async () => {
      requestCount += 1;
      return requestCount === 1 ? current : recovery.promise;
    });
    const release = setup.runtime.acquire();
    await setup.runtime.ready();
    setup.status.update({ phase: 'synced' });
    await vi.waitFor(() => {
      expect(setup.api.getCurrentSession).toHaveBeenCalledTimes(2);
    });
    const recoveryWork = activeSessionRecovery(setup.runtime);
    const snapshotBeforeDispose = setup.runtime.getSnapshot();
    const metadataBeforeDispose = await database.metadata.get(USER_A);

    release();
    await setup.runtime.closed();
    recovery.resolve({
      ...current, deviceName: 'Disposed recovery device',
      expiresAt: '2026-07-19T04:00:00.000Z',
    });
    await recoveryWork;
    await database.open();

    expect(setup.runtime.getSnapshot()).toBe(snapshotBeforeDispose);
    expect(await database.metadata.get(USER_A)).toEqual(metadataBeforeDispose);
  });

  it('keeps logout authoritative after an old in-flight sync returns', async () => {
    const database = createSyncDatabase(`runtime-inflight-logout-${crypto.randomUUID()}`);
    databases.push(database);
    const api = accountApi();
    const pull = deferred<PullChangesResponse>();
    const pullStarted = deferred<void>();
    api.pullChanges = async (cursor: number) => {
      api.calls.push(`pull:${cursor}`);
      pullStarted.resolve();
      return pull.promise;
    };
    const engine = new SyncEngine({ database, api, now: () => new Date(NOW) });
    const scheduler = { start: vi.fn(), stop: vi.fn() };
    const runtime = new AppRuntime({
      database, api: api as never, engine, scheduler,
    });
    const release = runtime.acquire();
    await runtime.ready();
    const oldCycle = engine.manualSync();
    await pullStarted.promise;
    const operation = await runtime.queueFor(USER_A).createTask(TASK_ID, {
      title: 'In-flight retained task', subject: 'Math',
      defaultPomodoroTarget: 2, defaultTimerPreset: '25-5', notes: null,
    });

    await runtime.logout();
    expect(runtime.getSnapshot()).toMatchObject({
      authMode: 'authRequired', session: null,
    });
    pull.resolve({ changes: [], nextCursor: 0, hasMore: false });
    await oldCycle;

    expect((await database.metadata.get(USER_A))?.authState).toBe('required');
    expect(engine.status.getSnapshot().phase).not.toBe('synced');
    expect((await database.operations.get(operation.sequence ?? 0))).toMatchObject({
      operationId: operation.operationId, state: 'pending',
    });
    expect((await database.replicas.get(replicaKey(USER_A, 'task', TASK_ID)))
      ?.projectedValue).toMatchObject({ title: 'In-flight retained task' });
    release();
    await runtime.closed();

    const restarted = runtimeWith(database, async () => { throw new NetworkError(); });
    const releaseRestarted = restarted.runtime.acquire();
    await restarted.runtime.ready();
    expect(restarted.runtime.getSnapshot().authMode).toBe('authRequired');
    releaseRestarted();
    await restarted.runtime.closed();
  });

  it('resumes the original operation after login without an old cycle committing it', async () => {
    const database = createSyncDatabase(`runtime-inflight-login-${crypto.randomUUID()}`);
    databases.push(database);
    const api = accountApi();
    const firstPush = deferred<PushOperationsResponse>();
    const pushStarted = deferred<void>();
    const pushedBatches: SyncOperation[][] = [];
    let pushCount = 0;
    api.pushOperations = async (operations: readonly SyncOperation[]) => {
      const batch = [...operations];
      pushedBatches.push(batch);
      pushCount += 1;
      if (pushCount === 1) {
        pushStarted.resolve();
        return firstPush.promise;
      }
      return {
        receipts: batch.map((operation) => ({
          operationId: operation.operationId,
          status: 'duplicate' as const,
          entityVersion: 1,
          conflictId: null,
          errorCode: null,
          errorMessage: null,
        })),
        latestCursor: 0,
      };
    };
    const refreshed = {
      ...session(), deviceName: 'New authenticated laptop',
      expiresAt: '2026-07-16T04:00:00.000Z',
    };
    api.login.mockResolvedValue(refreshed);
    const engine = new SyncEngine({ database, api, now: () => new Date(NOW) });
    const runtime = new AppRuntime({
      database,
      api: api as never,
      engine,
      scheduler: { start: vi.fn(), stop: vi.fn() },
    });
    const release = runtime.acquire();
    await runtime.ready();
    const operation = await runtime.queueFor(USER_A).createTask(TASK_ID, {
      title: 'Resume same operation', subject: 'Math',
      defaultPomodoroTarget: 2, defaultTimerPreset: '25-5', notes: null,
    });
    const oldCycle = engine.manualSync();
    await pushStarted.promise;
    await runtime.authenticationRequired();
    api.sessions.push(refreshed, refreshed);
    const login = runtime.login('learner', 'secure password');
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().session?.deviceName)
        .toBe('New authenticated laptop');
    });
    firstPush.resolve({
      receipts: [{
        operationId: operation.operationId,
        status: 'applied', entityVersion: 1, conflictId: null,
        errorCode: null, errorMessage: null,
      }],
      latestCursor: 0,
    });
    await Promise.all([oldCycle, login]);
    await vi.waitFor(() => {
      expect(runtime.getSnapshot()).toMatchObject({
        authMode: 'authenticated', session: refreshed,
      });
    });

    expect(pushedBatches).toHaveLength(2);
    expect(pushedBatches.map((batch) => batch[0]?.operationId))
      .toEqual([operation.operationId, operation.operationId]);
    expect(await database.operations.get(operation.sequence ?? 0)).toMatchObject({
      operationId: operation.operationId,
      state: 'acknowledged',
      receipt: { status: 'duplicate' },
    });
    expect(await database.metadata.get(USER_A)).toMatchObject({
      authState: 'authenticated',
      deviceName: refreshed.deviceName,
      sessionExpiresAt: refreshed.expiresAt,
    });
    release();
    await runtime.closed();
  });

  it('handles engine 401 and repeated runtime pause without deadlock', async () => {
    const database = createSyncDatabase(`runtime-engine-401-${crypto.randomUUID()}`);
    databases.push(database);
    const api = accountApi();
    const engine = new SyncEngine({ database, api, now: () => new Date(NOW) });
    const runtime = new AppRuntime({
      database,
      api: api as never,
      engine,
      scheduler: { start: vi.fn(), stop: vi.fn() },
    });
    const release = runtime.acquire();
    await runtime.ready();
    api.sessions.push(new AuthRequiredError());
    await expect(engine.manualSync()).resolves.toBeUndefined();
    expect(await database.metadata.get(USER_A)).toMatchObject({
      authState: 'required',
    });
    expect(engine.status.getSnapshot().phase).toBe('authRequired');
    expect(runtime.getSnapshot().authMode).toBe('authRequired');

    const refreshed = { ...session(), deviceName: 'Reauthenticated laptop' };
    api.login.mockResolvedValue(refreshed);
    api.sessions.push(refreshed, refreshed);
    await runtime.login('learner', 'secure password');
    await vi.waitFor(() => {
      expect(runtime.getSnapshot()).toMatchObject({
        authMode: 'authenticated', session: refreshed,
      });
    });
    release();
    await runtime.closed();
  });

  it('closes an in-flight sync without publishing errors or synced state', async () => {
    const database = createSyncDatabase(`runtime-inflight-close-${crypto.randomUUID()}`);
    databases.push(database);
    const close = vi.spyOn(database, 'close');
    const api = accountApi();
    const pull = deferred<PullChangesResponse>();
    const pullStarted = deferred<void>();
    let pullSignal: AbortSignal | undefined;
    api.pullChanges = async (
      cursor: number,
      _limit?: number,
      signal?: AbortSignal,
    ) => {
      api.calls.push(`pull:${cursor}`);
      pullSignal = signal;
      pullStarted.resolve();
      return pull.promise;
    };
    const engine = new SyncEngine({ database, api, now: () => new Date(NOW) });
    const scheduler = { start: vi.fn(), stop: vi.fn() };
    const runtime = new AppRuntime({
      database, api: api as never, engine, scheduler,
    });
    const release = runtime.acquire();
    await runtime.ready();
    const snapshotBeforeClose = runtime.getSnapshot();
    void engine.manualSync();
    await pullStarted.promise;
    release();
    await vi.waitFor(() => expect(pullSignal?.aborted).toBe(true));
    pull.resolve({ changes: [], nextCursor: 0, hasMore: false });
    await runtime.closed();

    expect(scheduler.stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot()).toBe(snapshotBeforeClose);
    expect(engine.status.getSnapshot().phase).toBe('syncing');
    expect(engine.status.getSnapshot().lastErrorCode).toBeNull();
  });
});
