import {
  TaskSchema,
  type CreateTaskRequest,
  type Task,
  type UpdateTaskRequest,
} from '@kaoyan/contracts';
import {
  defaultChangeLogWriter,
  iso,
  type ServiceDependencies,
} from './common';
import { EntityNotFoundError, StaleVersionError } from './errors';

interface TaskRow {
  id: string;
  title: string;
  subject: string;
  default_pomodoro_target: number;
  default_timer_preset: '25-5' | '50-10' | 'custom';
  notes: string | null;
  archived: number;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}
const select = `
  SELECT
    id, title, subject, default_pomodoro_target, default_timer_preset,
    notes, archived, version, created_at, updated_at, deleted_at
  FROM tasks
`;
function serialize(row: TaskRow): Task {
  return TaskSchema.parse({
    id: row.id,
    title: row.title,
    subject: row.subject,
    defaultPomodoroTarget: row.default_pomodoro_target,
    defaultTimerPreset: row.default_timer_preset,
    notes: row.notes,
    archived: Boolean(row.archived),
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: iso(row.deleted_at),
  });
}

export function createTaskService(deps: ServiceDependencies) {
  const write = deps.writeChange ?? defaultChangeLogWriter;
  const getCurrent = (userId: string, id: string) =>
    deps.sqlite
      .prepare(`${select} WHERE id=? AND user_id=?`)
      .get(id, userId) as TaskRow | undefined;
  const afterFailed = (userId: string, id: string): never => {
    const row = getCurrent(userId, id);
    if (!row || row.deleted_at !== null) throw new EntityNotFoundError();
    throw new StaleVersionError(row.version);
  };
  const finish = (
    userId: string,
    id: string,
    now: number,
    changeType: 'upsert' | 'delete',
  ) => {
    const row = getCurrent(userId, id);
    if (!row) throw new EntityNotFoundError();
    const entity = serialize(row);
    write(deps.sqlite, {
      userId,
      entityType: 'task',
      entityId: id,
      version: entity.version,
      changeType,
      payload: changeType === 'delete' ? null : entity,
      changedAt: now,
    });
    return entity;
  };
  return {
    create(userId: string, input: CreateTaskRequest) {
      return deps.sqlite.transaction(() => {
        const now = deps.now().getTime();
        deps.sqlite
          .prepare(
            `
              INSERT INTO tasks (
                id, user_id, title, subject, default_pomodoro_target,
                default_timer_preset, notes, archived, version,
                created_at, updated_at, deleted_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, NULL)
            `,
          )
          .run(
            input.id,
            userId,
            input.title,
            input.subject,
            input.defaultPomodoroTarget,
            input.defaultTimerPreset,
            input.notes ?? null,
            now,
            now,
          );
        return finish(userId, input.id, now, 'upsert');
      })();
    },
    list(userId: string, filter: 'active' | 'archived' | 'all' = 'active') {
      const condition =
        filter === 'all'
          ? ''
          : filter === 'archived'
            ? ' AND archived=1'
            : ' AND archived=0';
      return (
        deps.sqlite
          .prepare(
            `${select} WHERE user_id=? AND deleted_at IS NULL${condition} ORDER BY archived ASC, updated_at DESC, id ASC`,
          )
          .all(userId) as TaskRow[]
      ).map(serialize);
    },
    update(userId: string, id: string, input: UpdateTaskRequest) {
      const { expectedVersion, ...patch } = input;
      return deps.sqlite.transaction(() => {
        const now = deps.now().getTime();
        const current = getCurrent(userId, id);
        if (!current || current.deleted_at !== null)
          throw new EntityNotFoundError();
        const next = {
          title: patch.title ?? current.title,
          subject: patch.subject ?? current.subject,
          target:
            patch.defaultPomodoroTarget ?? current.default_pomodoro_target,
          preset: patch.defaultTimerPreset ?? current.default_timer_preset,
          notes: patch.notes === undefined ? current.notes : patch.notes,
        };
        const result = deps.sqlite
          .prepare(
            `
              UPDATE tasks
              SET title = ?, subject = ?, default_pomodoro_target = ?,
                  default_timer_preset = ?, notes = ?, version = version + 1,
                  updated_at = ?
              WHERE id = ? AND user_id = ? AND version = ?
                AND deleted_at IS NULL
            `,
          )
          .run(
            next.title,
            next.subject,
            next.target,
            next.preset,
            next.notes,
            now,
            id,
            userId,
            expectedVersion,
          );
        if (!result.changes) afterFailed(userId, id);
        return finish(userId, id, now, 'upsert');
      })();
    },
    setArchived(
      userId: string,
      id: string,
      expectedVersion: number,
      archived: boolean,
    ) {
      return deps.sqlite.transaction(() => {
        const now = deps.now().getTime();
        const result = deps.sqlite
          .prepare(
            `
              UPDATE tasks
              SET archived = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND user_id = ? AND version = ?
                AND deleted_at IS NULL
            `,
          )
          .run(archived ? 1 : 0, now, id, userId, expectedVersion);
        if (!result.changes) afterFailed(userId, id);
        return finish(userId, id, now, 'upsert');
      })();
    },
    delete(userId: string, id: string, expectedVersion: number) {
      return deps.sqlite.transaction(() => {
        const now = deps.now().getTime();
        const result = deps.sqlite
          .prepare(
            `
              UPDATE tasks
              SET deleted_at = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND user_id = ? AND version = ?
                AND deleted_at IS NULL
            `,
          )
          .run(now, now, id, userId, expectedVersion);
        if (!result.changes) afterFailed(userId, id);
        return finish(userId, id, now, 'delete');
      })();
    },
    get(userId: string, id: string) {
      const row = getCurrent(userId, id);
      return row && row.deleted_at === null ? serialize(row) : null;
    },
  };
}
