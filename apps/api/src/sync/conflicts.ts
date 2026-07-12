import {
  ConflictListResponseSchema,
  ConflictSchema,
  ResolveConflictResponseSchema,
  type Conflict,
  type ResolveConflictRequest,
} from '@kaoyan/contracts';
import type Database from 'better-sqlite3';
import { createDailyTaskService } from '../services/daily-tasks';
import { EntityNotFoundError } from '../services/errors';
import { createTaskService } from '../services/tasks';

interface Dependencies {
  sqlite: Database.Database;
  now: () => Date;
}
interface Row {
  id: string;
  entity_type: 'task' | 'dailyTask';
  entity_id: string;
  conflict_type: 'delete_modify' | 'complete_restore' | 'archive_add_today';
  local_operation_id: string;
  base_version: number;
  server_version: number;
  local_payload: string;
  server_payload: string;
  status: 'open' | 'resolved';
  resolution: string | null;
  created_at: number;
  resolved_at: number | null;
}
const select = `SELECT id,entity_type,entity_id,conflict_type,local_operation_id,base_version,server_version,local_payload,server_payload,status,resolution,created_at,resolved_at FROM conflicts`;
function serialize(row: Row): Conflict {
  return ConflictSchema.parse({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    conflictType: row.conflict_type,
    localOperationId: row.local_operation_id,
    baseVersion: row.base_version,
    serverVersion: row.server_version,
    localPayload: JSON.parse(row.local_payload),
    serverPayload: JSON.parse(row.server_payload),
    status: row.status,
    resolution: row.resolution,
    createdAt: new Date(row.created_at).toISOString(),
    resolvedAt:
      row.resolved_at === null ? null : new Date(row.resolved_at).toISOString(),
  });
}

export function createConflictService(deps: Dependencies) {
  const tasks = createTaskService(deps),
    daily = createDailyTaskService(deps);
  const getRow = (userId: string, id: string) =>
    deps.sqlite
      .prepare(`${select} WHERE id=? AND user_id=?`)
      .get(id, userId) as Row | undefined;
  return {
    list(userId: string) {
      return ConflictListResponseSchema.parse({
        conflicts: (
          deps.sqlite
            .prepare(
              `${select} WHERE user_id=? ORDER BY status ASC,created_at ASC,id ASC`,
            )
            .all(userId) as Row[]
        ).map(serialize),
      });
    },
    get(userId: string, id: string) {
      const row = getRow(userId, id);
      if (!row) throw new EntityNotFoundError();
      return serialize(row);
    },
    resolve(userId: string, id: string, input: ResolveConflictRequest) {
      return deps.sqlite.transaction(() => {
        const row = getRow(userId, id);
        if (!row) throw new EntityNotFoundError();
        if (row.status === 'resolved')
          return ResolveConflictResponseSchema.parse({
            conflict: serialize(row),
            affectedVersions: {},
          });
        const affected: Record<string, number> = {};
        if (row.conflict_type === 'delete_modify') {
          const current =
            row.entity_type === 'task'
              ? tasks.getAny(userId, row.entity_id)
              : daily.getAny(userId, row.entity_id);
          if (!current) throw new EntityNotFoundError();
          if (input.resolution === 'applyDelete' && !current.deletedAt) {
            const e =
              row.entity_type === 'task'
                ? tasks.delete(userId, row.entity_id, current.version)
                : daily.delete(userId, row.entity_id, current.version);
            affected[e.id] = e.version;
          } else if (input.resolution === 'copyAsNew') {
            if (row.entity_type !== 'task')
              throw new Error('copyAsNew only supports tasks');
            const snapshot = JSON.parse(row.server_payload) as {
              title: string;
              subject: string;
              defaultPomodoroTarget: number;
              defaultTimerPreset: '25-5' | '50-10' | 'custom';
              notes: string | null;
            };
            const e = tasks.create(userId, {
              id: input.newEntityId,
              title: snapshot.title,
              subject: snapshot.subject,
              defaultPomodoroTarget: snapshot.defaultPomodoroTarget,
              defaultTimerPreset: snapshot.defaultTimerPreset,
              notes: snapshot.notes,
            });
            affected[e.id] = e.version;
          } else if (input.resolution !== 'keepServer')
            throw new Error('Invalid resolution');
        } else if (row.conflict_type === 'complete_restore') {
          if (input.resolution !== 'complete' && input.resolution !== 'restore')
            throw new Error('Invalid resolution');
          const current = daily.getAny(userId, row.entity_id);
          if (!current || current.deletedAt) throw new EntityNotFoundError();
          const desired = input.resolution === 'complete';
          if ((current.status === 'completed') !== desired) {
            const e = daily.setCompleted(
              userId,
              row.entity_id,
              current.version,
              desired,
            );
            affected[e.id] = e.version;
          } else affected[current.id] = current.version;
        } else {
          const payload = JSON.parse(row.local_payload) as {
            sourceTaskId: string;
            date: string;
            sortOrder: number;
          };
          const source = tasks.getAny(userId, payload.sourceTaskId);
          if (!source || source.deletedAt) throw new EntityNotFoundError();
          if (
            input.resolution === 'addAnyway' ||
            input.resolution === 'unarchiveAndAdd'
          ) {
            if (input.resolution === 'unarchiveAndAdd' && source.archived) {
              const t = tasks.setArchived(
                userId,
                source.id,
                source.version,
                false,
              );
              affected[t.id] = t.version;
            }
            const e = daily.addFromTask(userId, source.id, {
              id: row.entity_id,
              date: payload.date,
              sortOrder: payload.sortOrder,
            });
            affected[e.id] = e.version;
          } else if (input.resolution !== 'keepArchived')
            throw new Error('Invalid resolution');
        }
        const now = deps.now().getTime();
        deps.sqlite
          .prepare(
            `UPDATE conflicts SET status='resolved',resolution=?,resolved_at=? WHERE id=? AND user_id=? AND status='open'`,
          )
          .run(input.resolution, now, id, userId);
        const resolved = getRow(userId, id);
        if (!resolved) throw new EntityNotFoundError();
        return ResolveConflictResponseSchema.parse({
          conflict: serialize(resolved),
          affectedVersions: affected,
        });
      })();
    },
  };
}
