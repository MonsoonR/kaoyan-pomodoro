import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from './client';
import { migrateDatabase } from './migrate';

const requiredTables = [
  'active_timer',
  'conflicts',
  'daily_tasks',
  'devices',
  'focus_sessions',
  'sessions',
  'settings',
  'sync_changes',
  'sync_operations',
  'tasks',
  'users',
];

describe('SQLite schema migrations', () => {
  let connection: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    connection = openDatabase(':memory:');
    migrateDatabase(connection.db);
  });

  afterEach(() => {
    connection.close();
  });

  it('creates every required table with foreign keys enabled', () => {
    const tables = connection.sqlite
      .prepare(
        `
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `,
      )
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((row) => row.name);

    expect(tableNames).toEqual(expect.arrayContaining(requiredTables));
    expect(connection.sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({
      foreign_keys: 1,
    });
    expect(connection.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual(
      [],
    );

    for (const table of [
      'active_timer',
      'conflicts',
      'daily_tasks',
      'devices',
      'focus_sessions',
      'sessions',
      'settings',
      'sync_changes',
      'sync_operations',
      'tasks',
    ]) {
      expect(
        connection.sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all()
          .length,
        table,
      ).toBeGreaterThan(0);
    }
  });

  it('adds version, server timestamp, and soft-delete columns to synchronized entities', () => {
    for (const table of [
      'active_timer',
      'tasks',
      'daily_tasks',
      'focus_sessions',
      'settings',
    ]) {
      const rows = connection.sqlite
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{
        dflt_value: string | null;
        name: string;
        notnull: number;
        type: string;
      }>;
      const columns = new Map(rows.map((row) => [row.name, row]));

      expect(columns.get('version'), table).toMatchObject({
        dflt_value: '1',
        notnull: 1,
        type: 'INTEGER',
      });
      expect(columns.get('updated_at'), table).toMatchObject({
        notnull: 1,
        type: 'INTEGER',
      });
      expect(columns.get('deleted_at'), table).toMatchObject({
        notnull: 0,
        type: 'INTEGER',
      });
    }
  });

  it('creates synchronization indexes and enforces one global active timer', () => {
    const indexes = connection.sqlite
      .prepare(
        `
      SELECT name
      FROM sqlite_schema
      WHERE type = 'index'
      ORDER BY name
    `,
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((row) => row.name);

    expect(indexNames).toEqual(
      expect.arrayContaining([
        'conflicts_open_idx',
        'daily_tasks_user_date_sort_idx',
        'sync_changes_user_cursor_idx',
        'tasks_user_updated_idx',
      ]),
    );

    const now = 1_789_000_000_000;
    connection.sqlite.exec(`
      INSERT INTO users (
        id, singleton_key, username, password_hash,
        password_changed_at, created_at, updated_at
      ) VALUES (
        '018f556e-5bbb-7850-8117-41a14e88b577', 1, 'owner', 'hash',
        ${now}, ${now}, ${now}
      );

      INSERT INTO daily_tasks (
        id, user_id, source_task_id, date, title, subject,
        pomodoro_target, pomodoro_completed, timer_preset, status,
        sort_order, version, created_at, updated_at, deleted_at
      ) VALUES (
        '028f556e-5bbb-7850-8117-41a14e88b577',
        '018f556e-5bbb-7850-8117-41a14e88b577',
        NULL, '2026-07-12', '高等数学', '数学',
        4, 0, '50-10', 'pending', 0, 1, ${now}, ${now}, NULL
      );

      INSERT INTO active_timer (
        id, singleton_key, user_id, daily_task_id, phase, status,
        planned_seconds, started_at, target_end_at, paused_at,
        accumulated_paused_seconds, version, created_at, updated_at
      ) VALUES (
        '038f556e-5bbb-7850-8117-41a14e88b577', 1,
        '018f556e-5bbb-7850-8117-41a14e88b577',
        '028f556e-5bbb-7850-8117-41a14e88b577',
        'focus', 'running', 3000, ${now}, ${now + 3_000_000}, NULL,
        0, 1, ${now}, ${now}
      );
    `);

    const secondTimerSql = `
      INSERT INTO active_timer (
        id, singleton_key, user_id, daily_task_id, phase, status,
        planned_seconds, started_at, target_end_at, paused_at,
        accumulated_paused_seconds, version, created_at, updated_at
      ) VALUES (
        '048f556e-5bbb-7850-8117-41a14e88b577', 1,
        '018f556e-5bbb-7850-8117-41a14e88b577',
        '028f556e-5bbb-7850-8117-41a14e88b577',
        'focus', 'running', 1500, ${now}, ${now + 1_500_000}, NULL,
        0, 1, ${now}, ${now}
      );
    `;

    expect(() => connection.sqlite.exec(secondTimerSql)).toThrow(/UNIQUE/);

    connection.sqlite
      .prepare(
        `
      UPDATE active_timer SET deleted_at = ? WHERE id = ?
    `,
      )
      .run(now + 1, '038f556e-5bbb-7850-8117-41a14e88b577');
    expect(() => connection.sqlite.exec(secondTimerSql)).not.toThrow();
  });

  it('enforces single-account, single-settings, version, timestamp, and foreign-key rules', () => {
    const now = 1_789_000_000_000;
    connection.sqlite
      .prepare(
        `
      INSERT INTO users (
        id, singleton_key, username, password_hash,
        password_changed_at, created_at, updated_at
      ) VALUES (?, 1, ?, 'hash', ?, ?, ?)
    `,
      )
      .run('118f556e-5bbb-7850-8117-41a14e88b577', 'owner', now, now, now);

    expect(() =>
      connection.sqlite
        .prepare(
          `
      INSERT INTO users (
        id, singleton_key, username, password_hash,
        password_changed_at, created_at, updated_at
      ) VALUES (?, 1, ?, 'hash', ?, ?, ?)
    `,
        )
        .run('128f556e-5bbb-7850-8117-41a14e88b577', 'other', now, now, now),
    ).toThrow(/UNIQUE/);

    connection.sqlite
      .prepare('INSERT INTO settings (id, user_id) VALUES (?, ?)')
      .run(
        '138f556e-5bbb-7850-8117-41a14e88b577',
        '118f556e-5bbb-7850-8117-41a14e88b577',
      );
    expect(() =>
      connection.sqlite
        .prepare('INSERT INTO settings (id, user_id) VALUES (?, ?)')
        .run(
          '148f556e-5bbb-7850-8117-41a14e88b577',
          '118f556e-5bbb-7850-8117-41a14e88b577',
        ),
    ).toThrow(/UNIQUE/);

    expect(() =>
      connection.sqlite
        .prepare(
          `
      INSERT INTO tasks (
        id, user_id, title, subject,
        default_pomodoro_target, default_timer_preset, version
      ) VALUES (?, ?, '高等数学', '数学', 4, '50-10', 1)
    `,
        )
        .run('158f556e-5bbb-7850-8117-41a14e88b577', 'missing-user'),
    ).toThrow(/FOREIGN KEY/);

    expect(() =>
      connection.sqlite
        .prepare(
          `
      INSERT INTO tasks (
        id, user_id, title, subject,
        default_pomodoro_target, default_timer_preset, version
      ) VALUES (?, ?, '高等数学', '数学', 4, '50-10', 0)
    `,
        )
        .run(
          '168f556e-5bbb-7850-8117-41a14e88b577',
          '118f556e-5bbb-7850-8117-41a14e88b577',
        ),
    ).toThrow(/CHECK/);

    connection.sqlite
      .prepare(
        `
      INSERT INTO tasks (
        id, user_id, title, subject,
        default_pomodoro_target, default_timer_preset
      ) VALUES (?, ?, '高等数学', '数学', 4, '50-10')
    `,
      )
      .run(
        '178f556e-5bbb-7850-8117-41a14e88b577',
        '118f556e-5bbb-7850-8117-41a14e88b577',
      );
    const task = connection.sqlite
      .prepare(
        `
      SELECT version, created_at, updated_at FROM tasks WHERE id = ?
    `,
      )
      .get('178f556e-5bbb-7850-8117-41a14e88b577') as {
      created_at: number;
      updated_at: number;
      version: number;
    };

    expect(task.version).toBe(1);
    expect(task.created_at).toBeGreaterThan(0);
    expect(task.updated_at).toBeGreaterThan(0);
  });

  it('applies migrations idempotently and passes SQLite integrity checks', () => {
    migrateDatabase(connection.db);

    expect(connection.sqlite.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    });
  });

  it('rejects duplicate operation IDs and assigns strictly increasing change cursors', () => {
    const now = 1_789_000_000_000;
    connection.sqlite.exec(`
      INSERT INTO users (id, singleton_key, username, password_hash, password_changed_at)
      VALUES ('user-1', 1, 'owner', 'hash', ${now});
      INSERT INTO devices (id, user_id, name, browser, operating_system, last_active_at)
      VALUES ('device-1', 'user-1', 'Laptop', 'Chrome', 'Windows', ${now});
      INSERT INTO sync_operations (
        operation_id, user_id, device_id, entity_type, entity_id, operation_type,
        base_version, payload, status, entity_version, created_at
      ) VALUES ('operation-1', 'user-1', 'device-1', 'task', 'task-1', 'create', 0, '{}', 'applied', 1, ${now});
      INSERT INTO sync_changes (user_id, entity_type, entity_id, version, change_type, payload)
      VALUES ('user-1', 'task', 'task-1', 1, 'upsert', '{}');
      INSERT INTO sync_changes (user_id, entity_type, entity_id, version, change_type, payload)
      VALUES ('user-1', 'task', 'task-1', 2, 'upsert', '{}');
    `);

    expect(() =>
      connection.sqlite.exec(`
      INSERT INTO sync_operations (
        operation_id, user_id, device_id, entity_type, entity_id, operation_type,
        base_version, payload, status, entity_version, created_at
      ) VALUES ('operation-1', 'user-1', 'device-1', 'task', 'task-2', 'create', 0, '{}', 'applied', 1, ${now});
    `),
    ).toThrow(/UNIQUE/);

    const cursors = connection.sqlite
      .prepare('SELECT cursor FROM sync_changes ORDER BY cursor')
      .all() as Array<{ cursor: number }>;
    expect(cursors).toHaveLength(2);
    expect(cursors[1]!.cursor).toBeGreaterThan(cursors[0]!.cursor);
  });

  it('declares key onDelete policies and preserves operation credentials on revocation', () => {
    type ForeignKey = { from: string; on_delete: string; table: string };
    const policies = (table: string) =>
      connection.sqlite
        .prepare(`PRAGMA foreign_key_list(${table})`)
        .all() as ForeignKey[];

    expect(policies('sessions')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'device_id',
          on_delete: 'CASCADE',
          table: 'devices',
        }),
        expect.objectContaining({
          from: 'user_id',
          on_delete: 'CASCADE',
          table: 'users',
        }),
      ]),
    );
    expect(policies('daily_tasks')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'source_task_id',
          on_delete: 'SET NULL',
          table: 'tasks',
        }),
      ]),
    );
    expect(policies('sync_operations')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'device_id',
          on_delete: 'RESTRICT',
          table: 'devices',
        }),
      ]),
    );

    const now = 1_789_000_000_000;
    connection.sqlite.exec(`
      INSERT INTO users (id, singleton_key, username, password_hash, password_changed_at)
      VALUES ('user-1', 1, 'owner', 'hash', ${now});
      INSERT INTO devices (id, user_id, name, browser, operating_system, last_active_at)
      VALUES ('device-1', 'user-1', 'Laptop', 'Chrome', 'Windows', ${now});
      INSERT INTO sessions (id, user_id, device_id, token_hash, expires_at, last_seen_at)
      VALUES ('session-1', 'user-1', 'device-1', 'token', ${now + 1000}, ${now});
      INSERT INTO sync_operations (
        operation_id, user_id, device_id, entity_type, entity_id, operation_type,
        base_version, payload, status, entity_version, created_at
      ) VALUES ('operation-1', 'user-1', 'device-1', 'task', 'task-1', 'create', 0, '{}', 'applied', 1, ${now});
      UPDATE sessions SET revoked_at = ${now + 1} WHERE id = 'session-1';
    `);
    expect(
      connection.sqlite
        .prepare('SELECT count(*) AS count FROM sync_operations')
        .get(),
    ).toEqual({ count: 1 });
    expect(() =>
      connection.sqlite
        .prepare('DELETE FROM devices WHERE id = ?')
        .run('device-1'),
    ).toThrow(/FOREIGN KEY/);
    expect(
      connection.sqlite
        .prepare('SELECT count(*) AS count FROM sync_operations')
        .get(),
    ).toEqual({ count: 1 });
  });

  it('reopens and remigrates a temporary file database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kaoyan-pomodoro-'));
    const source = join(directory, 'schema.sqlite');
    let fileConnection: ReturnType<typeof openDatabase> | undefined;

    try {
      fileConnection = openDatabase(source);
      migrateDatabase(fileConnection.db);
      expect(
        fileConnection.sqlite.pragma('journal_mode', { simple: true }),
      ).toBe('wal');
      fileConnection.close();
      fileConnection = undefined;

      fileConnection = openDatabase(source);
      migrateDatabase(fileConnection.db);
      expect(
        fileConnection.sqlite.prepare('PRAGMA integrity_check').get(),
      ).toEqual({
        integrity_check: 'ok',
      });
    } finally {
      fileConnection?.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
