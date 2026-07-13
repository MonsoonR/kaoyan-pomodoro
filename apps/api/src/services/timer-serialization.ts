import {
  ActiveTimerSchema,
  type ActiveTimer,
} from '@kaoyan/contracts';
import { iso } from './common';

export interface ActiveTimerRow {
  id: string;
  daily_task_id: string;
  task_title: string;
  subject: string;
  phase: 'focus' | 'short_break' | 'long_break';
  status: 'running' | 'paused';
  planned_seconds: number;
  started_at: number;
  target_end_at: number;
  paused_at: number | null;
  accumulated_paused_seconds: number;
  interruption_reason: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export const activeTimerSelect = `
  SELECT id,daily_task_id,task_title,subject,phase,status,planned_seconds,
         started_at,target_end_at,paused_at,accumulated_paused_seconds,
         interruption_reason,version,created_at,updated_at,deleted_at
  FROM active_timer
`;

export function serializeActiveTimer(row: ActiveTimerRow): ActiveTimer {
  return ActiveTimerSchema.parse({
    id: row.id,
    dailyTaskId: row.daily_task_id,
    taskTitle: row.task_title,
    subject: row.subject,
    phase: row.phase,
    status: row.status,
    plannedSeconds: row.planned_seconds,
    startedAt: iso(row.started_at),
    targetEndAt: iso(row.target_end_at),
    pausedAt: iso(row.paused_at),
    accumulatedPausedSeconds: row.accumulated_paused_seconds,
    interruptionReason: row.interruption_reason,
    version: row.version,
    updatedAt: iso(row.updated_at),
    deletedAt: iso(row.deleted_at),
  });
}
