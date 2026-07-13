import {
  ConflictListResponseSchema,
  ConflictResolutionSchema,
  ConflictSchema,
  CurrentResolvedConflictResultSchema,
  DailyTaskSchema,
  ResolvedConflictResultSchema,
  ResolveConflictRequestSchema,
  ResolveConflictResponseSchema,
  TaskSchema,
  type Conflict,
  type ConflictType,
  type CurrentResolvedConflictResult,
  type ResolveConflictRequest,
} from '@kaoyan/contracts';
import type Database from 'better-sqlite3';
import { createDailyTaskService } from '../services/daily-tasks';
import {
  ConflictAlreadyResolvedError,
  ConflictResolutionTargetExistsError,
  EntityNotFoundError,
  InvalidConflictResolutionError,
} from '../services/errors';
import { createTaskService } from '../services/tasks';

interface Dependencies {
  sqlite: Database.Database;
  now: () => Date;
  writeResolutionResult?: (
    sqlite: Database.Database,
    values: ResolutionResultValues,
  ) => void;
}
interface ResolutionResultValues {
  id: string;
  userId: string;
  resolution: string;
  resolutionResult: CurrentResolvedConflictResult;
  resolvedAt: number;
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
  resolution_result: string | null;
  created_at: number;
  resolved_at: number | null;
}
const select = `SELECT id,entity_type,entity_id,conflict_type,local_operation_id,base_version,server_version,local_payload,server_payload,status,resolution,resolution_result,created_at,resolved_at FROM conflicts`;
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
    resolutionResult:
      row.resolution_result === null
        ? null
        : JSON.parse(row.resolution_result),
    createdAt: new Date(row.created_at).toISOString(),
    resolvedAt:
      row.resolved_at === null ? null : new Date(row.resolved_at).toISOString(),
  });
}

const legalResolutions: Record<ConflictType, ReadonlySet<string>> = {
  delete_modify: new Set(['keepServer', 'applyDelete', 'copyAsNew']),
  complete_restore: new Set(['complete', 'restore']),
  archive_add_today: new Set([
    'keepArchived',
    'addAnyway',
    'unarchiveAndAdd',
  ]),
};

const defaultWriteResolutionResult = (
  sqlite: Database.Database,
  values: ResolutionResultValues,
) => {
  const result = sqlite
    .prepare(
      `UPDATE conflicts
       SET status='resolved', resolution=?, resolution_result=?, resolved_at=?
       WHERE id=? AND user_id=? AND status='open'`,
    )
    .run(
      values.resolution,
      JSON.stringify(values.resolutionResult),
      values.resolvedAt,
      values.id,
      values.userId,
    );
  if (result.changes !== 1) throw new Error('Conflict resolution write failed');
};

export function createConflictService(deps: Dependencies) {
  const tasks = createTaskService(deps),
    daily = createDailyTaskService(deps);
  const writeResolutionResult =
    deps.writeResolutionResult ?? defaultWriteResolutionResult;
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
        const normalizedInput = ResolveConflictRequestSchema.parse(input);
        if (row.status === 'resolved') {
          if (!row.resolution_result)
            throw new Error('Resolved conflict is missing its result');
          const saved = ResolvedConflictResultSchema.parse(
            JSON.parse(row.resolution_result),
          );
          if ('legacy' in saved)
            throw new ConflictAlreadyResolvedError(
              ConflictResolutionSchema.parse(row.resolution),
              saved,
            );
          if (
            JSON.stringify(saved.resolutionRequest) !==
            JSON.stringify(normalizedInput)
          )
            throw new ConflictAlreadyResolvedError(
              ConflictResolutionSchema.parse(
                row.resolution ?? saved.resolutionRequest.resolution,
              ),
              saved,
            );
          return ResolveConflictResponseSchema.parse({
            conflict: serialize(row),
            affectedVersions: saved.affectedVersions,
          });
        }
        if (!legalResolutions[row.conflict_type].has(normalizedInput.resolution))
          throw new InvalidConflictResolutionError(
            row.conflict_type,
            normalizedInput.resolution,
          );
        if (
          normalizedInput.resolution === 'copyAsNew' &&
          (row.entity_type === 'task'
            ? tasks.getAny(userId, normalizedInput.newEntityId)
            : daily.getAny(userId, normalizedInput.newEntityId))
        )
          throw new ConflictResolutionTargetExistsError(
            normalizedInput.newEntityId,
          );
        if (
          row.conflict_type === 'archive_add_today' &&
          (normalizedInput.resolution === 'addAnyway' ||
            normalizedInput.resolution === 'unarchiveAndAdd') &&
          daily.getAny(userId, row.entity_id)
        )
          throw new ConflictResolutionTargetExistsError(row.entity_id);
        const affected: Record<string, number> = {};
        if (row.conflict_type === 'delete_modify') {
          const current =
            row.entity_type === 'task'
              ? tasks.getAny(userId, row.entity_id)
              : daily.getAny(userId, row.entity_id);
          if (!current) throw new EntityNotFoundError();
          if (normalizedInput.resolution === 'applyDelete' && !current.deletedAt) {
            const e =
              row.entity_type === 'task'
                ? tasks.delete(userId, row.entity_id, current.version)
                : daily.delete(userId, row.entity_id, current.version);
            affected[e.id] = e.version;
          } else if (normalizedInput.resolution === 'copyAsNew') {
            const e =
              row.entity_type === 'task'
                ? tasks.copyFromSnapshot(
                    userId,
                    normalizedInput.newEntityId,
                    TaskSchema.parse(current),
                  )
                : daily.copyFromSnapshot(
                    userId,
                    normalizedInput.newEntityId,
                    DailyTaskSchema.parse(current),
                  );
            affected[e.id] = e.version;
            if (!current.deletedAt) {
              const deleted =
                row.entity_type === 'task'
                  ? tasks.delete(userId, row.entity_id, current.version)
                  : daily.delete(userId, row.entity_id, current.version);
              affected[deleted.id] = deleted.version;
            } else affected[current.id] = current.version;
          }
        } else if (row.conflict_type === 'complete_restore') {
          const current = daily.getAny(userId, row.entity_id);
          if (!current || current.deletedAt) throw new EntityNotFoundError();
          const desired = normalizedInput.resolution === 'complete';
          const alreadyDesired = desired
            ? current.status === 'completed'
            : current.status === 'pending';
          if (!alreadyDesired) {
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
            normalizedInput.resolution === 'addAnyway' ||
            normalizedInput.resolution === 'unarchiveAndAdd'
          ) {
            if (
              normalizedInput.resolution === 'unarchiveAndAdd' &&
              source.archived
            ) {
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
          }
        }
        const now = deps.now().getTime();
        const resolutionResult = CurrentResolvedConflictResultSchema.parse({
          resolutionRequest: normalizedInput,
          affectedVersions: affected,
        } satisfies CurrentResolvedConflictResult);
        writeResolutionResult(deps.sqlite, {
          id,
          userId,
          resolution: normalizedInput.resolution,
          resolutionResult,
          resolvedAt: now,
        });
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
