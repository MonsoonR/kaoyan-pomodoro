import {
  DailyTaskSchema,
  type CreateDailyTaskRequest,
  type DailyTask,
  type UpdateDailyTaskRequest,
} from '@kaoyan/contracts';
import {
  defaultChangeLogWriter,
  iso,
  type ServiceDependencies,
} from './common';
import { EntityNotFoundError, StaleVersionError } from './errors';

interface Row {
  id: string;
  source_task_id: string | null;
  date: string;
  title: string;
  subject: string;
  pomodoro_target: number;
  pomodoro_completed: number;
  timer_preset: '25-5' | '50-10' | 'custom';
  status: 'pending' | 'active' | 'awaiting_confirmation' | 'completed';
  sort_order: number;
  completed_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}
const select = `
  SELECT
    id, source_task_id, date, title, subject, pomodoro_target,
    pomodoro_completed, timer_preset, status, sort_order, completed_at,
    version, created_at, updated_at, deleted_at
  FROM daily_tasks
`;
function serialize(r: Row): DailyTask {
  return DailyTaskSchema.parse({
    id: r.id,
    sourceTaskId: r.source_task_id,
    date: r.date,
    title: r.title,
    subject: r.subject,
    pomodoroTarget: r.pomodoro_target,
    pomodoroCompleted: r.pomodoro_completed,
    timerPreset: r.timer_preset,
    status: r.status,
    sortOrder: r.sort_order,
    completedAt: iso(r.completed_at),
    version: r.version,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    deletedAt: iso(r.deleted_at),
  });
}
export function createDailyTaskService(deps: ServiceDependencies) {
  const write = deps.writeChange ?? defaultChangeLogWriter;
  const get = (u: string, id: string) =>
    deps.sqlite.prepare(`${select} WHERE id=? AND user_id=?`).get(id, u) as
      | Row
      | undefined;
  const fail = (u: string, id: string): never => {
    const r = get(u, id);
    if (!r || r.deleted_at !== null) throw new EntityNotFoundError();
    throw new StaleVersionError(r.version);
  };
  const finish = (u: string, id: string, n: number, t: 'upsert' | 'delete') => {
    const r = get(u, id);
    if (!r) throw new EntityNotFoundError();
    const e = serialize(r);
    write(deps.sqlite, {
      userId: u,
      entityType: 'dailyTask',
      entityId: id,
      version: e.version,
      changeType: t,
      payload: t === 'delete' ? null : e,
      changedAt: n,
    });
    return e;
  };
  const insert = (
    u: string,
    input: CreateDailyTaskRequest,
    sourceTaskId: string | null,
  ) =>
    deps.sqlite.transaction(() => {
      const n = deps.now().getTime();
      deps.sqlite
        .prepare(
          `
            INSERT INTO daily_tasks (
              id, user_id, source_task_id, date, title, subject,
              pomodoro_target, pomodoro_completed, timer_preset, status,
              sort_order, completed_at, version, created_at, updated_at,
              deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?, NULL, 1, ?, ?, NULL)
          `,
        )
        .run(
          input.id,
          u,
          sourceTaskId,
          input.date,
          input.title,
          input.subject,
          input.pomodoroTarget,
          input.timerPreset,
          input.sortOrder,
          n,
          n,
        );
      return finish(u, input.id, n, 'upsert');
    })();
  return {
    createTemporary(u: string, input: CreateDailyTaskRequest) {
      return insert(u, input, null);
    },
    copyFromSnapshot(u: string, id: string, snapshot: DailyTask) {
      return deps.sqlite.transaction(() => {
        const n = deps.now().getTime();
        deps.sqlite
          .prepare(
            `
              INSERT INTO daily_tasks (
                id, user_id, source_task_id, date, title, subject,
                pomodoro_target, pomodoro_completed, timer_preset, status,
                sort_order, completed_at, version, created_at, updated_at,
                deleted_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
            `,
          )
          .run(
            id,
            u,
            snapshot.sourceTaskId,
            snapshot.date,
            snapshot.title,
            snapshot.subject,
            snapshot.pomodoroTarget,
            snapshot.pomodoroCompleted,
            snapshot.timerPreset,
            snapshot.status,
            snapshot.sortOrder,
            snapshot.completedAt === null
              ? null
              : new Date(snapshot.completedAt).getTime(),
            n,
            n,
          );
        return finish(u, id, n, 'upsert');
      })();
    },
    addFromTask(
      u: string,
      taskId: string,
      input: { id: string; date: string; sortOrder: number },
    ) {
      const t = deps.sqlite
        .prepare(
          `SELECT title,subject,default_pomodoro_target,default_timer_preset FROM tasks WHERE id=? AND user_id=? AND deleted_at IS NULL`,
        )
        .get(taskId, u) as
        | {
            title: string;
            subject: string;
            default_pomodoro_target: number;
            default_timer_preset: '25-5' | '50-10' | 'custom';
          }
        | undefined;
      if (!t) throw new EntityNotFoundError();
      return insert(
        u,
        {
          id: input.id,
          date: input.date,
          title: t.title,
          subject: t.subject,
          pomodoroTarget: t.default_pomodoro_target,
          timerPreset: t.default_timer_preset,
          sortOrder: input.sortOrder,
        },
        taskId,
      );
    },
    list(u: string, date: string) {
      return (
        deps.sqlite
          .prepare(
            `${select} WHERE user_id=? AND date=? AND deleted_at IS NULL ORDER BY sort_order ASC,id ASC`,
          )
          .all(u, date) as Row[]
      ).map(serialize);
    },
    update(u: string, id: string, input: UpdateDailyTaskRequest) {
      const { expectedVersion, ...p } = input;
      return deps.sqlite.transaction(() => {
        const n = deps.now().getTime(),
          r = get(u, id);
        if (!r || r.deleted_at !== null) throw new EntityNotFoundError();
        const result = deps.sqlite
          .prepare(
            `
              UPDATE daily_tasks
              SET title = ?, subject = ?, pomodoro_target = ?, timer_preset = ?,
                  sort_order = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND user_id = ? AND version = ?
                AND deleted_at IS NULL
            `,
          )
          .run(
            p.title ?? r.title,
            p.subject ?? r.subject,
            p.pomodoroTarget ?? r.pomodoro_target,
            p.timerPreset ?? r.timer_preset,
            p.sortOrder ?? r.sort_order,
            n,
            id,
            u,
            expectedVersion,
          );
        if (!result.changes) fail(u, id);
        return finish(u, id, n, 'upsert');
      })();
    },
    setCompleted(u: string, id: string, v: number, complete: boolean) {
      return deps.sqlite.transaction(() => {
        const n = deps.now().getTime();
        const result = deps.sqlite
          .prepare(
            `
              UPDATE daily_tasks
              SET status = ?, completed_at = ?, version = version + 1,
                  updated_at = ?
              WHERE id = ? AND user_id = ? AND version = ?
                AND deleted_at IS NULL
            `,
          )
          .run(
            complete ? 'completed' : 'pending',
            complete ? n : null,
            n,
            id,
            u,
            v,
          );
        if (!result.changes) fail(u, id);
        return finish(u, id, n, 'upsert');
      })();
    },
    delete(u: string, id: string, v: number) {
      return deps.sqlite.transaction(() => {
        const n = deps.now().getTime();
        const result = deps.sqlite
          .prepare(
            `
              UPDATE daily_tasks
              SET deleted_at = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND user_id = ? AND version = ?
                AND deleted_at IS NULL
            `,
          )
          .run(n, n, id, u, v);
        if (!result.changes) fail(u, id);
        return finish(u, id, n, 'delete');
      })();
    },
    getAny(u: string, id: string) {
      const row = get(u, id);
      return row ? serialize(row) : null;
    },
  };
}
