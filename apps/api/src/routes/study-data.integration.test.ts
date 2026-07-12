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
  password = 'correct horse battery staple';
const taskId = '33333333-3333-4333-8333-333333333333',
  dailyId = '44444444-4444-4444-8444-444444444444';
let db: DatabaseConnection,
  app: Awaited<ReturnType<typeof createApp>>,
  dir: string,
  cookie: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'task4-http-'));
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
});
afterEach(async () => {
  await app.close();
  if (db.sqlite.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});
const headers = { origin, 'content-type': 'application/json' };
describe('study data HTTP routes', () => {
  it('requires authentication on task, daily-task, and settings reads', async () => {
    for (const url of [
      '/api/tasks',
      '/api/daily-tasks?date=2026-07-13',
      '/api/settings',
    ])
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });
  it('enforces origin and JSON guards on writes', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/tasks',
          headers: { ...headers, origin: 'https://evil.test', cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/tasks',
          headers: { origin, cookie, 'content-type': 'text/plain' },
          payload: 'x',
        })
      ).statusCode,
    ).toBe(415);
  });
  it('creates, lists, archives and reports stale versions with stable responses', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { ...headers, cookie },
      payload: {
        id: taskId,
        title: 'Math',
        subject: 'Algebra',
        defaultPomodoroTarget: 4,
        defaultTimerPreset: '50-10',
        notes: null,
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      id: taskId,
      version: 1,
      archived: false,
    });
    const archived = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/archive`,
      headers: { ...headers, cookie },
      payload: { expectedVersion: 1 },
    });
    expect(archived.json()).toMatchObject({ archived: true, version: 2 });
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { ...headers, cookie },
      payload: { expectedVersion: 1, title: 'Old' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      code: 'STALE_VERSION',
      message: 'Entity version is stale',
      currentVersion: 2,
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/tasks?filter=archived',
          headers: { cookie },
        })
      ).json().tasks,
    ).toHaveLength(1);
  });
  it('supports add-to-today, temporary creation, completion and restore', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { ...headers, cookie },
      payload: {
        id: taskId,
        title: 'Math',
        subject: 'Algebra',
        defaultPomodoroTarget: 4,
        defaultTimerPreset: '50-10',
      },
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/tasks/${taskId}/add-to-today`,
          headers: { ...headers, cookie },
          payload: { id: dailyId, date: '2026-07-13', sortOrder: 0 },
        })
      ).json(),
    ).toMatchObject({ sourceTaskId: taskId, status: 'pending' });
    const completed = await app.inject({
      method: 'POST',
      url: `/api/daily-tasks/${dailyId}/complete`,
      headers: { ...headers, cookie },
      payload: { expectedVersion: 1 },
    });
    expect(completed.json()).toMatchObject({ status: 'completed', version: 2 });
    const restored = await app.inject({
      method: 'POST',
      url: `/api/daily-tasks/${dailyId}/restore`,
      headers: { ...headers, cookie },
      payload: { expectedVersion: 2 },
    });
    expect(restored.json()).toMatchObject({
      status: 'pending',
      completedAt: null,
      version: 3,
    });
  });
  it('reads and validates non-empty versioned settings patches', async () => {
    const current = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie },
    });
    expect(current.json()).toMatchObject({
      version: 1,
      defaultPreset: '50-10',
    });
    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { ...headers, cookie },
      payload: { expectedVersion: 1, customFocusMinutes: 180 },
    });
    expect(updated.json()).toMatchObject({
      version: 2,
      customFocusMinutes: 180,
    });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/settings',
          headers: { ...headers, cookie },
          payload: { expectedVersion: 2, customFocusMinutes: 181 },
        })
      ).statusCode,
    ).toBe(400);
  });
});
