import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { initializeAccount } from './account-service';
import { TEST_PASSWORD_OPTIONS } from './password';
import { openDatabase, type DatabaseConnection } from '../db/client';
import { migrateDatabase } from '../db/migrate';

const origin = 'https://example.test';
const password = 'correct horse battery staple';
const taskId = '11111111-1111-4111-8111-111111111111';
const otherTaskId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const conflictId = '44444444-4444-4444-8444-444444444444';

describe('authenticated tenant isolation', () => {
  let database: DatabaseConnection;
  let app: Awaited<ReturnType<typeof createApp>>;
  let directory: string;
  let adminCookie: string;
  let userA: { cookie: string; userId: string; deviceId: string };
  let userB: { cookie: string; userId: string; deviceId: string };

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'kaoyan-tenants-'));
    database = openDatabase(join(directory, 'test.sqlite'));
    migrateDatabase(database.db);
    await initializeAccount(database.sqlite, {
      username: 'Owner', password, confirmPassword: password,
    }, TEST_PASSWORD_OPTIONS);
    app = await createApp({
      database,
      appOrigin: origin,
      passwordOptions: TEST_PASSWORD_OPTIONS,
      logger: false,
      loginRateLimit: { max: 100, timeWindow: '1 minute' },
    });
    const admin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin, 'content-type': 'application/json' },
      payload: { username: 'Owner', password },
    });
    adminCookie = String(admin.headers['set-cookie']).split(';')[0] ?? '';

    const register = async (username: string) => {
      const invite = await app.inject({
        method: 'POST',
        url: '/api/admin/invites',
        headers: {
          origin,
          cookie: adminCookie,
          'content-type': 'application/json',
        },
        payload: { expiresInHours: 24 },
      });
      const token = invite.json().inviteUrl.split('/#/invite/')[1];
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register-with-invite',
        headers: { origin, 'content-type': 'application/json' },
        payload: { token, username, password, confirmPassword: password },
      });
      return {
        cookie: String(response.headers['set-cookie']).split(';')[0] ?? '',
        userId: response.json().user.id as string,
        deviceId: response.json().deviceId as string,
      };
    };
    userA = await register('StudentA');
    userB = await register('StudentB');
  });

  afterEach(async () => {
    await app.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const writeHeaders = (cookie: string) => ({
    cookie,
    origin,
    'content-type': 'application/json',
  });

  it('prevents cross-user task reads, updates, and deletes even when the ID is known', async () => {
    expect((await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: writeHeaders(userA.cookie),
      payload: {
        id: taskId,
        title: 'Private task',
        subject: 'Private subject',
        defaultPomodoroTarget: 2,
        defaultTimerPreset: '50-10',
      },
    })).statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET', url: '/api/tasks', headers: { cookie: userB.cookie },
    });
    expect(list.json().tasks).toEqual([]);
    for (const request of [
      { method: 'PATCH', payload: { expectedVersion: 1, title: 'Stolen' } },
      { method: 'DELETE', payload: { expectedVersion: 1 } },
    ] as const) {
      const response = await app.inject({
        ...request,
        url: `/api/tasks/${taskId}`,
        headers: writeHeaders(userB.cookie),
      });
      expect(response.statusCode).toBe(404);
    }
    const ownerList = await app.inject({
      method: 'GET', url: '/api/tasks', headers: { cookie: userA.cookie },
    });
    expect(ownerList.json().tasks).toEqual([
      expect.objectContaining({ id: taskId, title: 'Private task' }),
    ]);
  });

  it('scopes operation receipts, pull cursors, and client-supplied identity', async () => {
    const operation = (entityId: string) => ({
      operationId,
      entityId,
      entityType: 'task',
      operationType: 'create',
      baseVersion: 0,
      createdAt: '2026-07-15T08:00:00.000Z',
      payload: {
        title: 'Synced task',
        subject: 'Math',
        defaultPomodoroTarget: 1,
        defaultTimerPreset: '25-5',
        notes: null,
      },
    });
    for (const [user, entityId] of [[userA, taskId], [userB, otherTaskId]] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sync/push',
        headers: writeHeaders(user.cookie),
        payload: { operations: [operation(entityId)] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().receipts[0]).toMatchObject({
        operationId, status: 'applied',
      });
    }
    const rows = database.sqlite.prepare(
      'SELECT user_id FROM sync_operations WHERE operation_id = ? ORDER BY user_id',
    ).all(operationId) as Array<{ user_id: string }>;
    expect(rows.map((row) => row.user_id).sort()).toEqual(
      [userA.userId, userB.userId].sort(),
    );

    const pullA = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?cursor=0&limit=100',
      headers: { cookie: userA.cookie },
    });
    const pullB = await app.inject({
      method: 'GET',
      url: `/api/sync/pull?cursor=${pullA.json().latestCursor}&limit=100`,
      headers: { cookie: userB.cookie },
    });
    expect(pullA.body).toContain(taskId);
    expect(pullA.body).not.toContain(otherTaskId);
    expect(pullB.body).not.toContain(taskId);

    const spoofed = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: writeHeaders(userB.cookie),
      payload: {
        operations: [{ ...operation(otherTaskId), userId: userA.userId }],
      },
    });
    expect(spoofed.json().receipts[0]).toMatchObject({
      status: 'rejected', errorCode: 'MALFORMED_OPERATION',
    });
  });

  it('prevents cross-user conflict and device access', async () => {
    const now = Date.now();
    database.sqlite.prepare(`
      INSERT INTO conflicts (
        id, user_id, device_id, entity_type, entity_id, conflict_type,
        local_operation_id, base_version, server_version, local_payload,
        server_payload, status, created_at
      ) VALUES (?, ?, ?, 'task', ?, 'delete_modify', ?, 1, 2, '{}', '{}', 'open', ?)
    `).run(conflictId, userA.userId, userA.deviceId, taskId, operationId, now);

    expect((await app.inject({
      method: 'GET',
      url: '/api/conflicts',
      headers: { cookie: userB.cookie },
    })).json().conflicts).toEqual([]);
    expect((await app.inject({
      method: 'GET',
      url: `/api/conflicts/${conflictId}`,
      headers: { cookie: userB.cookie },
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: 'POST',
      url: `/api/conflicts/${conflictId}/resolve`,
      headers: writeHeaders(userB.cookie),
      payload: { resolution: 'keepServer' },
    })).statusCode).toBe(404);

    expect((await app.inject({
      method: 'PATCH',
      url: `/api/devices/${userA.deviceId}`,
      headers: writeHeaders(userB.cookie),
      payload: { name: 'Not mine' },
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: 'DELETE',
      url: `/api/devices/${userA.deviceId}`,
      headers: writeHeaders(userB.cookie),
      payload: {},
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: userA.cookie },
    })).statusCode).toBe(200);
  });
});
