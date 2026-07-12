import type Database from 'better-sqlite3';

export interface ServiceDependencies {
  sqlite: Database.Database;
  now: () => Date;
  writeChange?: ChangeLogWriter;
}

export interface ChangeInput {
  userId: string;
  entityType: 'task' | 'dailyTask' | 'settings';
  entityId: string;
  version: number;
  changeType: 'upsert' | 'delete';
  payload: Record<string, unknown> | null;
  changedAt: number;
}

export type ChangeLogWriter = (sqlite: Database.Database, input: ChangeInput) => void;

export const defaultChangeLogWriter: ChangeLogWriter = (sqlite, input) => {
  sqlite.prepare(`INSERT INTO sync_changes
    (user_id,entity_type,entity_id,version,change_type,payload,changed_at)
    VALUES (?,?,?,?,?,?,?)`).run(
      input.userId, input.entityType, input.entityId, input.version,
      input.changeType, input.payload === null ? null : JSON.stringify(input.payload), input.changedAt,
    );
};

export function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
