import {
  FocusSessionSchema,
  type FocusSession,
} from '@kaoyan/contracts';
import type Database from 'better-sqlite3';
import { iso } from './common';

interface FocusSessionRow {
  id: string;
  daily_task_id: string | null;
  task_title: string;
  subject: string;
  phase: 'focus' | 'short_break' | 'long_break';
  planned_seconds: number;
  effective_seconds: number;
  started_at: number;
  ended_at: number;
  result: 'completed' | 'interrupted' | 'abandoned';
  interruption_reason: string | null;
  version: 1;
  created_at: number;
  updated_at: number;
  deleted_at: null;
}

const select = `SELECT id,daily_task_id,task_title,subject,phase,
  planned_seconds,effective_seconds,started_at,ended_at,result,
  interruption_reason,version,created_at,updated_at,deleted_at
  FROM focus_sessions`;

export function serializeFocusSession(row: FocusSessionRow): FocusSession {
  return FocusSessionSchema.parse({
    id: row.id,
    dailyTaskId: row.daily_task_id,
    taskTitle: row.task_title,
    subject: row.subject,
    phase: row.phase,
    plannedSeconds: row.planned_seconds,
    effectiveSeconds: row.effective_seconds,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    result: row.result,
    interruptionReason: row.interruption_reason,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: null,
  });
}

export function getFocusSession(
  sqlite: Database.Database,
  userId: string,
  id: string,
) {
  const row = sqlite
    .prepare(`${select} WHERE id=? AND user_id=?`)
    .get(id, userId) as FocusSessionRow | undefined;
  return row ? serializeFocusSession(row) : null;
}

export interface NewFocusSession {
  id: string;
  userId: string;
  dailyTaskId: string;
  taskTitle: string;
  subject: string;
  phase: 'focus' | 'short_break' | 'long_break';
  plannedSeconds: number;
  effectiveSeconds: number;
  startedAt: number;
  endedAt: number;
  result: 'completed' | 'interrupted';
  interruptionReason: string | null;
}

export function insertFocusSession(
  sqlite: Database.Database,
  input: NewFocusSession,
) {
  sqlite.prepare(`INSERT INTO focus_sessions(
    id,user_id,daily_task_id,task_title,subject,phase,planned_seconds,
    effective_seconds,started_at,ended_at,result,interruption_reason,
    version,created_at,updated_at,deleted_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,NULL)`).run(
    input.id,input.userId,input.dailyTaskId,input.taskTitle,input.subject,
    input.phase,input.plannedSeconds,input.effectiveSeconds,input.startedAt,
    input.endedAt,input.result,input.interruptionReason,input.endedAt,input.endedAt,
  );
  const session = getFocusSession(sqlite, input.userId, input.id);
  if (!session) throw new Error('Focus session insert failed');
  return session;
}
