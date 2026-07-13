import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { initializeAccount } from '../auth/account-service';
import { TEST_PASSWORD_OPTIONS } from '../auth/password';
import { openDatabase, type DatabaseConnection } from '../db/client';
import { migrateDatabase } from '../db/migrate';
const origin = 'https://example.test',
  password = 'correct horse battery staple',
  task = '33333333-3333-4333-8333-333333333333';
let db: DatabaseConnection,
  app: Awaited<ReturnType<typeof createApp>>,
  dir: string,
  cookie: string,
  n: number;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sync-http-'));
  db = openDatabase(join(dir, 'db.sqlite'));
  migrateDatabase(db.db);
  await initializeAccount(
    db.sqlite,
    { username: 'learner', password, confirmPassword: password },
    TEST_PASSWORD_OPTIONS,
  );
  app = await createApp({
    database: db,
    appOrigin: origin,
    passwordOptions: TEST_PASSWORD_OPTIONS,
    logger: false,
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin, 'content-type': 'application/json' },
    payload: { username: 'learner', password },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  n = 0;
});
afterEach(async () => {
  await app.close();
  if (db.sqlite.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});
const operation = (overrides: Record<string, unknown> = {}) => ({
  operationId: `90000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  entityType: 'task',
  entityId: task,
  operationType: 'create',
  baseVersion: 0,
  payload: {
    title: 'Math',
    subject: 'Algebra',
    defaultPomodoroTarget: 4,
    defaultTimerPreset: '50-10',
  },
  createdAt: '2026-07-13T10:00:00Z',
  ...overrides,
});
const push = (operations: unknown[]) =>
  app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: { origin, 'content-type': 'application/json', cookie },
    payload: { operations },
  });
describe('sync HTTP API', () => {
  it('requires cookie authentication and origin', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/api/sync/pull' })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/sync/push',
          headers: {
            origin: 'https://evil.test',
            'content-type': 'application/json',
            cookie,
          },
          payload: { operations: [operation()] },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('pulls initial settings from cursor zero', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?cursor=0',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().changes).toHaveLength(1);
    expect(response.json().changes[0]).toMatchObject({
      entityType: 'settings',
      version: 1,
      changeType: 'upsert',
    });
  });
  it('processes batch in order and continues after malformed and rejected items', async () => {
    const response = await push([
      operation(),
      { bad: true },
      operation({
        entityId: '44444444-4444-4444-8444-444444444444',
        entityType: 'activeTimer',
        operationType: 'timerStart',
        payload: { dailyTaskId: task, phase: 'focus', plannedSeconds: 60 },
      }),
    ]);
    expect(response.statusCode).toBe(200);
    expect(
      response.json().receipts.map((r: { status: string }) => r.status),
    ).toEqual(['applied', 'rejected', 'rejected']);
  });
  it('persists invalid timerStart baseVersion and continues the batch', async () => {
    const invalidTimer = operation({
      entityId: '48888888-8888-4888-8888-888888888888',
      entityType: 'activeTimer',
      operationType: 'timerStart',
      baseVersion: 1,
      payload: {
        dailyTaskId: '49999999-9999-4999-8999-999999999999',
        dailyTaskVersion: 1,
        phase: 'focus',
        plannedSeconds: 60,
      },
    });
    const validTask = operation();
    const first = await push([invalidTimer, validTask]);
    expect(first.json().receipts).toMatchObject([
      {
        status: 'rejected',
        errorCode: 'INVALID_BASE_VERSION',
        errorMessage: 'Create requires baseVersion 0',
      },
      { status: 'applied' },
    ]);
    const retry = await push([invalidTimer, validTask]);
    expect(retry.json().receipts).toMatchObject([
      { status: 'rejected', errorCode: 'INVALID_BASE_VERSION' },
      { status: 'duplicate' },
    ]);
    expect(
      db.sqlite.prepare('SELECT count(*) count FROM active_timer').get(),
    ).toEqual({ count: 0 });
    expect(
      db.sqlite.prepare('SELECT count(*) count FROM tasks WHERE id=?').get(task),
    ).toEqual({ count: 1 });
  });
  it('continues after a conflict and duplicates committed work on batch retry', async () => {
    const first = operation();
    await push([first]);
    const update = operation({
      operationType: 'update',
      baseVersion: 1,
      payload: { title: 'New' },
    });
    await push([update]);
    const deletion = operation({
        operationType: 'delete',
        baseVersion: 1,
        payload: {},
      }),
      next = operation({ entityId: '77777777-7777-4777-8777-777777777777' });
    const response = await push([deletion, next]);
    expect(
      response.json().receipts.map((r: { status: string }) => r.status),
    ).toEqual(['conflict', 'applied']);
    const retry = await push([deletion, next]);
    expect(
      retry.json().receipts.map((r: { status: string }) => r.status),
    ).toEqual(['conflict', 'duplicate']);
  });
  it('lists, reads and resolves conflicts', async () => {
    await push([operation()]);
    await push([
      operation({
        operationType: 'update',
        baseVersion: 1,
        payload: { title: 'New' },
      }),
    ]);
    const conflict = (
      await push([
        operation({ operationType: 'delete', baseVersion: 1, payload: {} }),
      ])
    ).json().receipts[0].conflictId;
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/conflicts',
          headers: { cookie },
        })
      ).json().conflicts,
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/conflicts/${conflict}`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${conflict}/resolve`,
      headers: { origin, 'content-type': 'application/json', cookie },
      payload: { resolution: 'keepServer' },
    });
    expect(resolved.json().conflict.status).toBe('resolved');
  });
  it('returns stable 400 responses for every conflict-resolution mismatch without writes', async () => {
    const user = db.sqlite.prepare('SELECT id FROM users').get() as { id: string };
    const device = db.sqlite.prepare('SELECT id FROM devices').get() as {
      id: string;
    };
    const conflictTypes = [
      {
        id: 'a1000000-0000-4000-8000-000000000001',
        type: 'delete_modify',
        entityType: 'task',
        legal: new Set(['keepServer', 'applyDelete', 'copyAsNew']),
      },
      {
        id: 'a1000000-0000-4000-8000-000000000002',
        type: 'complete_restore',
        entityType: 'dailyTask',
        legal: new Set(['complete', 'restore']),
      },
      {
        id: 'a1000000-0000-4000-8000-000000000003',
        type: 'archive_add_today',
        entityType: 'dailyTask',
        legal: new Set(['keepArchived', 'addAnyway', 'unarchiveAndAdd']),
      },
    ] as const;
    for (const conflict of conflictTypes) {
      db.sqlite
        .prepare(
          `INSERT INTO conflicts (
            id,user_id,device_id,entity_type,entity_id,conflict_type,
            local_operation_id,base_version,server_version,local_payload,
            server_payload,status,created_at
          ) VALUES (?,?,?,?,?,?,?,1,2,'{}','{}','open',?)`,
        )
        .run(
          conflict.id,
          user.id,
          device.id,
          conflict.entityType,
          'b1000000-0000-4000-8000-000000000001',
          conflict.type,
          `c1000000-0000-4000-8000-${conflict.id.slice(-12)}`,
          Date.parse('2026-07-13T10:00:00Z'),
        );
    }
    const requests = [
      { resolution: 'keepServer' },
      { resolution: 'applyDelete' },
      {
        resolution: 'copyAsNew',
        newEntityId: 'd1000000-0000-4000-8000-000000000001',
      },
      { resolution: 'complete' },
      { resolution: 'restore' },
      { resolution: 'keepArchived' },
      { resolution: 'addAnyway' },
      { resolution: 'unarchiveAndAdd' },
    ] as const;
    const before = {
      tasks: db.sqlite.prepare('SELECT count(*) count FROM tasks').get(),
      dailyTasks: db.sqlite
        .prepare('SELECT count(*) count FROM daily_tasks')
        .get(),
      changes: db.sqlite
        .prepare('SELECT count(*) count FROM sync_changes')
        .get(),
      receipts: db.sqlite
        .prepare('SELECT count(*) count FROM sync_operations')
        .get(),
    };
    for (const conflict of conflictTypes) {
      for (const request of requests.filter(
        (candidate) => !conflict.legal.has(candidate.resolution),
      )) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/conflicts/${conflict.id}/resolve`,
          headers: { origin, 'content-type': 'application/json', cookie },
          payload: request,
        });
        expect(response.statusCode, `${conflict.type}/${request.resolution}`).toBe(
          400,
        );
        expect(response.json()).toEqual({
          code: 'INVALID_CONFLICT_RESOLUTION',
          message: 'Resolution is not valid for this conflict type',
          conflictType: conflict.type,
          resolution: request.resolution,
        });
      }
    }
    expect({
      tasks: db.sqlite.prepare('SELECT count(*) count FROM tasks').get(),
      dailyTasks: db.sqlite
        .prepare('SELECT count(*) count FROM daily_tasks')
        .get(),
      changes: db.sqlite
        .prepare('SELECT count(*) count FROM sync_changes')
        .get(),
      receipts: db.sqlite
        .prepare('SELECT count(*) count FROM sync_operations')
        .get(),
    }).toEqual(before);
    expect(
      db.sqlite
        .prepare(
          "SELECT count(*) count FROM conflicts WHERE status='open' AND resolution IS NULL AND resolution_result IS NULL AND resolved_at IS NULL",
        )
        .get(),
    ).toEqual({ count: 3 });
  });
  it('returns the saved result with 409 for a different retry or newEntityId', async () => {
    await push([operation()]);
    await push([
      operation({
        operationType: 'update',
        baseVersion: 1,
        payload: { title: 'Server title' },
      }),
    ]);
    const conflictId = (
      await push([
        operation({ operationType: 'delete', baseVersion: 1, payload: {} }),
      ])
    ).json().receipts[0].conflictId as string;
    const firstRequest = {
      resolution: 'copyAsNew',
      newEntityId: 'e1000000-0000-4000-8000-000000000001',
    };
    const first = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${conflictId}/resolve`,
      headers: { origin, 'content-type': 'application/json', cookie },
      payload: firstRequest,
    });
    expect(first.statusCode).toBe(200);
    const before = {
      tasks: db.sqlite.prepare('SELECT count(*) count FROM tasks').get(),
      changes: db.sqlite
        .prepare('SELECT count(*) count FROM sync_changes')
        .get(),
      conflict: db.sqlite
        .prepare(
          'SELECT status,resolution,resolution_result,resolved_at FROM conflicts WHERE id=?',
        )
        .get(conflictId),
    };
    for (const payload of [
      { resolution: 'applyDelete' },
      {
        resolution: 'copyAsNew',
        newEntityId: 'e1000000-0000-4000-8000-000000000002',
      },
    ]) {
      const retry = await app.inject({
        method: 'POST',
        url: `/api/conflicts/${conflictId}/resolve`,
        headers: { origin, 'content-type': 'application/json', cookie },
        payload,
      });
      expect(retry.statusCode).toBe(409);
      expect(retry.json()).toEqual({
        code: 'CONFLICT_ALREADY_RESOLVED',
        message: 'Conflict was already resolved differently',
        resolution: 'copyAsNew',
        resolutionResult: {
          resolutionRequest: firstRequest,
          affectedVersions: first.json().affectedVersions,
        },
      });
    }
    expect({
      tasks: db.sqlite.prepare('SELECT count(*) count FROM tasks').get(),
      changes: db.sqlite
        .prepare('SELECT count(*) count FROM sync_changes')
        .get(),
      conflict: db.sqlite
        .prepare(
          'SELECT status,resolution,resolution_result,resolved_at FROM conflicts WHERE id=?',
        )
        .get(conflictId),
    }).toEqual(before);
  });
  it('returns stable 409 responses when conflict-resolution target IDs are occupied', async () => {
    await push([operation()]);
    await push([
      operation({
        operationType: 'update',
        baseVersion: 1,
        payload: { title: 'Server title' },
      }),
    ]);
    const copyConflictId = (
      await push([
        operation({ operationType: 'delete', baseVersion: 1, payload: {} }),
      ])
    ).json().receipts[0].conflictId as string;
    const copyTargetId = 'f1000000-0000-4000-8000-000000000001';
    await push([operation({ entityId: copyTargetId })]);
    const beforeCopy = db.sqlite
      .prepare('SELECT count(*) count FROM sync_changes')
      .get();
    const copyResponse = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${copyConflictId}/resolve`,
      headers: { origin, 'content-type': 'application/json', cookie },
      payload: { resolution: 'copyAsNew', newEntityId: copyTargetId },
    });
    expect(copyResponse.statusCode).toBe(409);
    expect(copyResponse.json()).toEqual({
      code: 'CONFLICT_RESOLUTION_TARGET_EXISTS',
      message: 'Conflict resolution target already exists',
      entityId: copyTargetId,
    });
    expect(
      db.sqlite.prepare('SELECT count(*) count FROM sync_changes').get(),
    ).toEqual(beforeCopy);
    expect(
      db.sqlite
        .prepare(
          'SELECT status,resolution_result FROM conflicts WHERE id=?',
        )
        .get(copyConflictId),
    ).toEqual({ status: 'open', resolution_result: null });

    const sourceId = 'f2000000-0000-4000-8000-000000000001';
    const dailyTargetId = 'f2000000-0000-4000-8000-000000000002';
    await push([operation({ entityId: sourceId })]);
    await push([
      operation({
        entityId: sourceId,
        operationType: 'archive',
        baseVersion: 1,
        payload: {},
      }),
    ]);
    const addConflictId = (
      await push([
        operation({
          entityId: dailyTargetId,
          entityType: 'dailyTask',
          operationType: 'addToToday',
          baseVersion: 0,
          payload: {
            sourceTaskId: sourceId,
            sourceTaskVersion: 1,
            date: '2026-07-13',
            sortOrder: 0,
          },
        }),
      ])
    ).json().receipts[0].conflictId as string;
    await push([
      operation({
        entityId: dailyTargetId,
        entityType: 'dailyTask',
        operationType: 'create',
        baseVersion: 0,
        payload: {
          sourceTaskId: null,
          date: '2026-07-13',
          title: 'Occupied',
          subject: 'Existing',
          pomodoroTarget: 1,
          timerPreset: '25-5',
          sortOrder: 0,
        },
      }),
    ]);
    const beforeAdd = db.sqlite
      .prepare('SELECT count(*) count FROM sync_changes')
      .get();
    const addResponse = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${addConflictId}/resolve`,
      headers: { origin, 'content-type': 'application/json', cookie },
      payload: { resolution: 'unarchiveAndAdd' },
    });
    expect(addResponse.statusCode).toBe(409);
    expect(addResponse.json()).toEqual({
      code: 'CONFLICT_RESOLUTION_TARGET_EXISTS',
      message: 'Conflict resolution target already exists',
      entityId: dailyTargetId,
    });
    expect(
      db.sqlite.prepare('SELECT count(*) count FROM sync_changes').get(),
    ).toEqual(beforeAdd);
    expect(
      db.sqlite
        .prepare(
          'SELECT archived,version FROM tasks WHERE id=?',
        )
        .get(sourceId),
    ).toEqual({ archived: 1, version: 2 });
    expect(
      db.sqlite
        .prepare(
          'SELECT status,resolution_result FROM conflicts WHERE id=?',
        )
        .get(addConflictId),
    ).toEqual({ status: 'open', resolution_result: null });
  });
  it('keeps a finite 768 KiB push body limit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { origin, 'content-type': 'application/json', cookie },
      payload: JSON.stringify({
        operations: [{ blob: 'x'.repeat(769 * 1024) }],
      }),
    });
    expect(response.statusCode).toBe(413);
  });
});
