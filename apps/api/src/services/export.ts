import {
  UserDataExportSchema,
  type UserDataExport,
} from '@kaoyan/contracts';
import type Database from 'better-sqlite3';

import { iso } from './common';

type SnapshotEstablishedHook = () => void;

interface AccountRow {
  id: string;
  username: string;
  role: 'admin' | 'user';
  must_change_password: number;
}

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

interface DailyTaskRow {
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
}

interface SettingsRow {
  id: string;
  default_preset: '25-5' | '50-10' | 'custom';
  custom_focus_minutes: number;
  custom_short_break_minutes: number;
  custom_long_break_minutes: number;
  long_break_interval: number;
  sound_enabled: number;
  notifications_enabled: number;
  version: number;
  created_at: number;
  updated_at: number;
}

interface ActiveTimerRow {
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
  updated_at: number;
  deleted_at: null;
}

interface DeviceRow {
  id: string;
  name: string;
  browser: string;
  operating_system: string;
  created_at: number;
  last_active_at: number;
  revoked_at: number | null;
}

interface ConflictRow {
  id: string;
  entity_type:
    | 'task'
    | 'dailyTask'
    | 'focusSession'
    | 'activeTimer'
    | 'settings';
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

function createSnapshot(
  sqlite: Database.Database,
  userId: string,
  currentDeviceId: string,
  exportedAt: Date,
  afterSnapshotEstablished?: SnapshotEstablishedHook,
): UserDataExport {
  const account = sqlite
    .prepare('SELECT id, username, role, must_change_password FROM users WHERE id = ?')
    .get(userId) as AccountRow | undefined;
  if (!account) throw new Error('Authenticated account not found');

  afterSnapshotEstablished?.();

  const tasks = (
    sqlite
      .prepare(`
        SELECT id,title,subject,default_pomodoro_target,default_timer_preset,
               notes,archived,version,created_at,updated_at,deleted_at
        FROM tasks
        WHERE user_id = ?
        ORDER BY created_at ASC, id ASC
      `)
      .all(userId) as TaskRow[]
  ).map((row) => ({
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
  }));

  const dailyTasks = (
    sqlite
      .prepare(`
        SELECT id,source_task_id,date,title,subject,pomodoro_target,
               pomodoro_completed,timer_preset,status,sort_order,completed_at,
               version,created_at,updated_at,deleted_at
        FROM daily_tasks
        WHERE user_id = ?
        ORDER BY date ASC, sort_order ASC, id ASC
      `)
      .all(userId) as DailyTaskRow[]
  ).map((row) => ({
    id: row.id,
    sourceTaskId: row.source_task_id,
    date: row.date,
    title: row.title,
    subject: row.subject,
    pomodoroTarget: row.pomodoro_target,
    pomodoroCompleted: row.pomodoro_completed,
    timerPreset: row.timer_preset,
    status: row.status,
    sortOrder: row.sort_order,
    completedAt: iso(row.completed_at),
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: iso(row.deleted_at),
  }));

  const focusSessions = (
    sqlite
      .prepare(`
        SELECT id,daily_task_id,task_title,subject,phase,planned_seconds,
               effective_seconds,started_at,ended_at,result,
               interruption_reason,version,created_at,updated_at
        FROM focus_sessions
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY started_at ASC, id ASC
      `)
      .all(userId) as FocusSessionRow[]
  ).map((row) => ({
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
  }));

  const settingsRow = sqlite
    .prepare(`
      SELECT id,default_preset,custom_focus_minutes,custom_short_break_minutes,
             custom_long_break_minutes,long_break_interval,sound_enabled,
             notifications_enabled,version,created_at,updated_at
      FROM settings
      WHERE user_id = ? AND deleted_at IS NULL
    `)
    .get(userId) as SettingsRow | undefined;
  const settings = settingsRow
    ? {
        id: settingsRow.id,
        defaultPreset: settingsRow.default_preset,
        customFocusMinutes: settingsRow.custom_focus_minutes,
        customShortBreakMinutes: settingsRow.custom_short_break_minutes,
        customLongBreakMinutes: settingsRow.custom_long_break_minutes,
        longBreakInterval: settingsRow.long_break_interval,
        soundEnabled: Boolean(settingsRow.sound_enabled),
        notificationsEnabled: Boolean(settingsRow.notifications_enabled),
        version: settingsRow.version,
        createdAt: iso(settingsRow.created_at),
        updatedAt: iso(settingsRow.updated_at),
        deletedAt: null,
      }
    : null;

  const timerRow = sqlite
    .prepare(`
      SELECT id,daily_task_id,task_title,subject,phase,status,planned_seconds,
             started_at,target_end_at,paused_at,accumulated_paused_seconds,
             interruption_reason,version,updated_at,deleted_at
      FROM active_timer
      WHERE user_id = ? AND deleted_at IS NULL
    `)
    .get(userId) as ActiveTimerRow | undefined;
  const activeTimer = timerRow
    ? {
        id: timerRow.id,
        dailyTaskId: timerRow.daily_task_id,
        taskTitle: timerRow.task_title,
        subject: timerRow.subject,
        phase: timerRow.phase,
        status: timerRow.status,
        plannedSeconds: timerRow.planned_seconds,
        startedAt: iso(timerRow.started_at),
        targetEndAt: iso(timerRow.target_end_at),
        pausedAt: iso(timerRow.paused_at),
        accumulatedPausedSeconds: timerRow.accumulated_paused_seconds,
        interruptionReason: timerRow.interruption_reason,
        version: timerRow.version,
        updatedAt: iso(timerRow.updated_at),
        deletedAt: null,
      }
    : null;

  const devices = (
    sqlite
      .prepare(`
        SELECT
          devices.id,
          devices.name,
          devices.browser,
          devices.operating_system,
          devices.created_at,
          devices.last_active_at,
          CASE
            WHEN COUNT(sessions.id) > 0
              AND SUM(CASE WHEN sessions.revoked_at IS NULL THEN 1 ELSE 0 END) = 0
            THEN MAX(sessions.revoked_at)
            ELSE NULL
          END AS revoked_at
        FROM devices
        LEFT JOIN sessions
          ON sessions.device_id = devices.id AND sessions.user_id = devices.user_id
        WHERE devices.user_id = ?
        GROUP BY devices.id
        ORDER BY devices.last_active_at ASC, devices.id ASC
      `)
      .all(userId) as DeviceRow[]
  ).map((row) => ({
    deviceId: row.id,
    deviceName: row.name,
    browser: row.browser,
    operatingSystem: row.operating_system,
    createdAt: iso(row.created_at),
    lastActiveAt: iso(row.last_active_at),
    current: row.id === currentDeviceId,
    revokedAt: iso(row.revoked_at),
  }));

  const conflicts = (
    sqlite
      .prepare(`
        SELECT id,entity_type,entity_id,conflict_type,local_operation_id,
               base_version,server_version,local_payload,server_payload,status,
               resolution,resolution_result,created_at,resolved_at
        FROM conflicts
        WHERE user_id = ?
        ORDER BY created_at ASC, id ASC
      `)
      .all(userId) as ConflictRow[]
  ).map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    conflictType: row.conflict_type,
    localOperationId: row.local_operation_id,
    baseVersion: row.base_version,
    serverVersion: row.server_version,
    localPayload: JSON.parse(row.local_payload) as Record<string, unknown>,
    serverPayload: JSON.parse(row.server_payload) as Record<string, unknown>,
    status: row.status,
    resolution: row.resolution,
    resolutionResult:
      row.resolution_result === null
        ? null
        : (JSON.parse(row.resolution_result) as Record<string, unknown>),
    createdAt: iso(row.created_at),
    resolvedAt: iso(row.resolved_at),
  }));

  return UserDataExportSchema.parse({
    exportVersion: 1,
    exportedAt: exportedAt.toISOString(),
    account: {
      id: account.id,
      username: account.username,
      role: account.role,
      mustChangePassword: Boolean(account.must_change_password),
    },
    tasks,
    dailyTasks,
    focusSessions,
    settings,
    activeTimer,
    devices,
    conflicts,
  });
}

export function createUserDataExport(
  sqlite: Database.Database,
  userId: string,
  currentDeviceId: string,
  exportedAt: Date,
  afterSnapshotEstablished?: SnapshotEstablishedHook,
): UserDataExport {
  return sqlite
    .transaction(() =>
      createSnapshot(
        sqlite,
        userId,
        currentDeviceId,
        exportedAt,
        afterSnapshotEstablished,
      ),
    )
    .deferred();
}
