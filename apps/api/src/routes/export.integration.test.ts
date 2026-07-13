import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UserDataExportSchema } from '@kaoyan/contracts';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { initializeAccount } from '../auth/account-service';
import { TEST_PASSWORD_OPTIONS } from '../auth/password';
import { openDatabase, type DatabaseConnection } from '../db/client';
import { migrateDatabase } from '../db/migrate';
import { createUserDataExport } from '../services/export';

const origin = 'https://pomodoro.example.test';
const password = 'correct horse battery staple';
const fixedNow = new Date('2026-07-13T08:09:10.123Z');
const ids = {
  taskA: '10000000-0000-4000-8000-000000000001',
  taskB: '10000000-0000-4000-8000-000000000002',
  taskDeleted: '10000000-0000-4000-8000-000000000003',
  dailyA: '20000000-0000-4000-8000-000000000001',
  dailyB: '20000000-0000-4000-8000-000000000002',
  dailyDeleted: '20000000-0000-4000-8000-000000000003',
  focusA: '30000000-0000-4000-8000-000000000001',
  focusB: '30000000-0000-4000-8000-000000000002',
  timer: '40000000-0000-4000-8000-000000000001',
  device: '50000000-0000-4000-8000-000000000001',
  session: '60000000-0000-4000-8000-000000000001',
  conflictOpen: '70000000-0000-4000-8000-000000000001',
  conflictResolved: '70000000-0000-4000-8000-000000000002',
  otherUser: '80000000-0000-4000-8000-000000000001',
  otherTask: '90000000-0000-4000-8000-000000000001',
};

let connection: DatabaseConnection;
let app: Awaited<ReturnType<typeof createApp>>;
let cookie: string;
let directory: string;
let databasePath: string;
let userId: string;

function insertFixtures() {
  const sqlite = connection.sqlite;
  const createdA = Date.parse('2026-07-11T00:00:00.000Z');
  const createdB = Date.parse('2026-07-12T00:00:00.000Z');
  const deletedAt = Date.parse('2026-07-13T00:00:00.000Z');

  const insertTask = sqlite.prepare(`
    INSERT INTO tasks (
      id,user_id,title,subject,default_pomodoro_target,default_timer_preset,
      notes,archived,version,created_at,updated_at,deleted_at
    ) VALUES (?,?,?,?,?,'25-5',?,0,1,?,?,?)
  `);
  insertTask.run(ids.taskB, userId, 'Task B', 'Math', 4, null, createdA, createdA, null);
  insertTask.run(ids.taskA, userId, 'Task A', 'Math', 4, null, createdA, createdA, null);
  insertTask.run(
    ids.taskDeleted,
    userId,
    'Deleted task',
    'English',
    2,
    'historical note',
    createdB,
    deletedAt,
    deletedAt,
  );

  const insertDaily = sqlite.prepare(`
    INSERT INTO daily_tasks (
      id,user_id,source_task_id,date,title,subject,pomodoro_target,
      pomodoro_completed,timer_preset,status,sort_order,completed_at,version,
      created_at,updated_at,deleted_at
    ) VALUES (?,?,?,'2026-07-13',?,?,4,0,'25-5','pending',?,NULL,1,?,?,?)
  `);
  insertDaily.run(ids.dailyB, userId, ids.taskB, 'Daily B', 'Math', 0, createdB, createdB, null);
  insertDaily.run(ids.dailyA, userId, ids.taskA, 'Daily A', 'Math', 0, createdB, createdB, null);
  insertDaily.run(
    ids.dailyDeleted,
    userId,
    ids.taskDeleted,
    'Deleted daily',
    'English',
    2,
    createdB,
    deletedAt,
    deletedAt,
  );

  const insertFocus = sqlite.prepare(`
    INSERT INTO focus_sessions (
      id,user_id,daily_task_id,task_title,subject,phase,planned_seconds,
      effective_seconds,started_at,ended_at,result,interruption_reason,
      version,created_at,updated_at,deleted_at
    ) VALUES (?,?,?,?,'Math','focus',1500,1500,?,?,'completed',NULL,1,?,?,NULL)
  `);
  insertFocus.run(ids.focusB, userId, ids.dailyB, 'Daily B', createdA, createdB, createdB, createdB);
  insertFocus.run(ids.focusA, userId, ids.dailyA, 'Daily A', createdA, createdB, createdB, createdB);

  sqlite.prepare(`
    INSERT INTO active_timer (
      id,singleton_key,user_id,daily_task_id,task_title,subject,phase,status,
      planned_seconds,started_at,target_end_at,paused_at,
      accumulated_paused_seconds,interruption_reason,version,created_at,
      updated_at,deleted_at
    ) VALUES (?,1,?,?,?,'Math','focus','running',1500,?,?,NULL,0,NULL,1,?,?,NULL)
  `).run(ids.timer, userId, ids.dailyA, 'Daily A', createdB, createdB + 1_500_000, createdB, createdB);

  sqlite.prepare(`
    INSERT INTO devices (
      id,user_id,name,browser,operating_system,last_active_at,created_at,updated_at
    ) VALUES (?,?,?,'Firefox','Linux',?,?,?)
  `).run(ids.device, userId, 'Study laptop', createdA, createdA, createdA);
  sqlite.prepare(`
    INSERT INTO sessions (
      id,user_id,device_id,token_hash,expires_at,last_seen_at,revoked_at,created_at
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(ids.session, userId, ids.device, 'DO_NOT_EXPORT_SESSION_HASH', deletedAt + 1_000_000, createdA, deletedAt, createdA);

  const insertConflict = sqlite.prepare(`
    INSERT INTO conflicts (
      id,user_id,device_id,entity_type,entity_id,conflict_type,
      local_operation_id,base_version,server_version,local_payload,
      server_payload,status,resolution,resolution_result,created_at,resolved_at
    ) VALUES (?,?,NULL,'task',?,'delete_modify',?,1,2,?,?,?, ?, ?, ?, ?)
  `);
  insertConflict.run(
    ids.conflictResolved,
    userId,
    ids.taskB,
    randomUUID(),
    JSON.stringify({ title: 'local' }),
    JSON.stringify({ title: 'server' }),
    'resolved',
    'keepServer',
    JSON.stringify({
      resolutionRequest: { resolution: 'keepServer' },
      affectedVersions: { [ids.taskB]: 2 },
    }),
    createdA,
    createdB,
  );
  insertConflict.run(
    ids.conflictOpen,
    userId,
    ids.taskA,
    randomUUID(),
    JSON.stringify({ title: 'local' }),
    JSON.stringify({ title: 'server' }),
    'open',
    null,
    null,
    createdA,
    null,
  );

  sqlite.exec('DROP INDEX users_singleton_idx');
  sqlite.prepare(`
    INSERT INTO users (
      id,singleton_key,username,password_hash,password_changed_at,created_at,
      updated_at,failed_login_count,last_failed_login_at,locked_until
    ) VALUES (?,1,'other-user','DO_NOT_EXPORT_OTHER_PASSWORD',?, ?, ?,0,NULL,NULL)
  `).run(ids.otherUser, createdA, createdA, createdA);
  insertTask.run(ids.otherTask, ids.otherUser, 'Other user task', 'Secret', 1, null, createdA, createdA, null);
  sqlite.prepare(`
    INSERT INTO sync_operations (
      operation_id,user_id,device_id,entity_type,entity_id,operation_type,
      base_version,payload,status,entity_version,conflict_id,error_code,
      error_message,created_at,processed_at
    ) VALUES (?,?,?,?,?,'update',1,?,'applied',2,NULL,NULL,NULL,?,?)
  `).run(randomUUID(), userId, ids.device, 'task', ids.taskA, JSON.stringify({ receipt: 'DO_NOT_EXPORT_SYNC_PAYLOAD' }), createdB, createdB);
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'export-route-'));
  databasePath = join(directory, 'database.sqlite');
  connection = openDatabase(databasePath);
  migrateDatabase(connection.db);
  await initializeAccount(
    connection.sqlite,
    { username: 'learner', password, confirmPassword: password },
    TEST_PASSWORD_OPTIONS,
  );
  userId = (connection.sqlite.prepare('SELECT id FROM users').get() as { id: string }).id;
  app = await createApp({
    database: connection,
    appOrigin: origin,
    now: () => fixedNow,
    passwordOptions: TEST_PASSWORD_OPTIONS,
    generateToken: () => 'plain-session-token',
    logger: false,
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: {
      origin,
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 Chrome/126.0 Windows NT 10.0',
    },
    payload: { username: 'learner', password },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  insertFixtures();
});

afterEach(async () => {
  await app.close();
  if (connection.sqlite.open) connection.close();
  rmSync(directory, { recursive: true, force: true });
});

async function download() {
  return app.inject({ method: 'GET', url: '/api/export', headers: { cookie } });
}

describe('GET /api/export', () => {
  it('requires authentication and never permits caching', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/export' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
  });

  it('downloads a schema-validated attachment with complete scoped history', async () => {
    const response = await download();
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="kaoyan-pomodoro-export-[0-9TZ-]+\.json"$/,
    );
    expect(response.headers['content-disposition']).not.toContain('learner');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');

    const body = UserDataExportSchema.parse(response.json());
    expect(body.exportVersion).toBe(1);
    expect(body.exportedAt).toBe(fixedNow.toISOString());
    expect(body.account).toEqual({ id: userId, username: 'learner' });
    expect(body.tasks.map((task) => task.id)).toEqual([
      ids.taskA,
      ids.taskB,
      ids.taskDeleted,
    ]);
    expect(body.tasks.find((task) => task.id === ids.taskDeleted)?.deletedAt).not.toBeNull();
    expect(body.tasks.some((task) => task.id === ids.otherTask)).toBe(false);
    expect(body.dailyTasks.map((task) => task.id)).toEqual([
      ids.dailyA,
      ids.dailyB,
      ids.dailyDeleted,
    ]);
    expect(body.dailyTasks.find((task) => task.id === ids.dailyDeleted)?.deletedAt).not.toBeNull();
    expect(body.focusSessions.map((session) => session.id)).toEqual([ids.focusA, ids.focusB]);
    expect(body.settings).toMatchObject({ defaultPreset: '50-10' });
    expect(body.activeTimer).toMatchObject({ id: ids.timer, status: 'running' });
    expect(body.conflicts.map((conflict) => conflict.id)).toEqual([
      ids.conflictOpen,
      ids.conflictResolved,
    ]);
    expect(body.conflicts.map((conflict) => conflict.status)).toEqual(['open', 'resolved']);
    expect(body.devices.some((device) => device.current)).toBe(true);
    expect(body.devices).toContainEqual(
      expect.objectContaining({
        deviceId: ids.device,
        deviceName: 'Study laptop',
        browser: 'Firefox',
        operatingSystem: 'Linux',
        current: false,
        revokedAt: fixedNow.toISOString().replace('08:09:10.123Z', '00:00:00.000Z'),
      }),
    );
  });

  it('omits authentication, protocol, filesystem, and other-user secrets', async () => {
    const text = (await download()).body;
    for (const secret of [
      password,
      'plain-session-token',
      'DO_NOT_EXPORT_SESSION_HASH',
      'DO_NOT_EXPORT_OTHER_PASSWORD',
      'DO_NOT_EXPORT_SYNC_PAYLOAD',
      databasePath,
      ids.otherUser,
      ids.otherTask,
    ]) {
      expect(text).not.toContain(secret);
    }
    for (const forbiddenKey of [
      'passwordHash',
      'password_hash',
      'tokenHash',
      'token_hash',
      'cookie',
      'syncOperations',
      'sync_operations',
      'receipt',
      'databasePath',
    ]) {
      expect(text).not.toContain(forbiddenKey);
    }
  });

  it('keeps business data deterministic across downloads', async () => {
    const first = UserDataExportSchema.parse((await download()).json());
    const second = UserDataExportSchema.parse((await download()).json());
    expect({ ...first, exportedAt: '<ignored>' }).toEqual({
      ...second,
      exportedAt: '<ignored>',
    });
  });

  it('uses one SQLite read snapshot when another connection writes mid-export', () => {
    const writer = new Database(databasePath);
    writer.pragma('journal_mode = WAL');
    const lateTask = 'a0000000-0000-4000-8000-000000000001';
    try {
      const result = createUserDataExport(
        connection.sqlite,
        userId,
        ids.device,
        fixedNow,
        () => {
          writer.prepare(`
            INSERT INTO tasks (
              id,user_id,title,subject,default_pomodoro_target,
              default_timer_preset,notes,archived,version,created_at,
              updated_at,deleted_at
            ) VALUES (?,?,?,'Math',1,'25-5',NULL,0,1,?,?,NULL)
          `).run(lateTask, userId, 'Late task', fixedNow.getTime(), fixedNow.getTime());
        },
      );
      expect(result.tasks.some((task) => task.id === lateTask)).toBe(false);
      expect(
        connection.sqlite.prepare('SELECT id FROM tasks WHERE id=?').get(lateTask),
      ).toBeDefined();
    } finally {
      writer.close();
    }
  });

  it('sanitizes internal SQLite errors without leaking SQL or paths', async () => {
    connection.sqlite.exec('DROP TABLE tasks');
    const response = await download();
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(response.body).not.toContain(databasePath);
    expect(response.body).not.toContain('SELECT');
    expect(response.body).not.toContain('tasks');
  });
});
