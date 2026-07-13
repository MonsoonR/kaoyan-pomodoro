import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncDatabase, type SyncDatabase } from '../db/database';
import { replicaKey } from '../db/types';
import { NOW, session, TASK_ID, USER_A } from '../test/fixtures';
import { AuthRequiredError, NetworkError } from '../sync/errors';
import { SyncStatusStore } from '../sync/status';
import { AppRuntime } from './app-runtime';

describe('application runtime lifecycle', () => {
  const databases: SyncDatabase[] = [];
  afterEach(async () => {
    for (const database of databases.splice(0))
      await database.deleteDatabaseForTests();
  });

  function runtimeWith(
    database: SyncDatabase,
    getCurrentSession: () => Promise<ReturnType<typeof session>>,
  ) {
    const status = new SyncStatusStore();
    const resumeAfterAuthentication = vi.fn(async () => undefined);
    const api = {
      getCurrentSession,
      login: vi.fn(async () => session()),
      logout: vi.fn(async () => ({ ok: true as const })),
    };
    const scheduler = { start: vi.fn(), stop: vi.fn() };
    const runtime = new AppRuntime({
      database,
      api: api as never,
      engine: { status, resumeAfterAuthentication } as never,
      scheduler,
    });
    return { runtime, api, resumeAfterAuthentication };
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
});
