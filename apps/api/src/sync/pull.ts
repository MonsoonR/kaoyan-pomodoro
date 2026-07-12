import {
  DailyTaskSchema,
  PullChangesResponseSchema,
  SettingsSchema,
  TaskSchema,
  type PullChangesResponse,
} from '@kaoyan/contracts';
import type Database from 'better-sqlite3';

interface ChangeRow {
  cursor: number;
  entity_type: 'task' | 'dailyTask' | 'settings';
  entity_id: string;
  version: number;
  change_type: 'upsert' | 'delete';
  payload: string | null;
  changed_at: number;
}

export function pullChanges(
  sqlite: Database.Database,
  userId: string,
  cursor: number,
  limit: number,
): PullChangesResponse {
  const rows = sqlite
    .prepare(
      `
        SELECT cursor, entity_type, entity_id, version, change_type,
               payload, changed_at
        FROM sync_changes
        WHERE user_id = ? AND cursor > ?
        ORDER BY cursor ASC
        LIMIT ?
      `,
    )
    .all(userId, cursor, limit + 1) as ChangeRow[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const changes = page.map((row) => {
    let payload: Record<string, unknown> | null = null;
    if (row.change_type === 'upsert') {
      const raw: unknown = JSON.parse(row.payload ?? 'null');
      const schema =
        row.entity_type === 'task'
          ? TaskSchema
          : row.entity_type === 'dailyTask'
            ? DailyTaskSchema
            : SettingsSchema;
      payload = schema.parse(raw);
    }
    return {
      cursor: row.cursor,
      entityType: row.entity_type,
      entityId: row.entity_id,
      version: row.version,
      changeType: row.change_type,
      payload,
      changedAt: new Date(row.changed_at).toISOString(),
    };
  });
  return PullChangesResponseSchema.parse({
    changes,
    nextCursor: page.at(-1)?.cursor ?? cursor,
    hasMore,
  });
}

export function latestCursor(sqlite: Database.Database, userId: string) {
  return (
    sqlite
      .prepare(
        'SELECT COALESCE(MAX(cursor), 0) AS cursor FROM sync_changes WHERE user_id = ?',
      )
      .get(userId) as { cursor: number }
  ).cursor;
}
