import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

type JsonObject = Record<string, unknown>;

const nowInMilliseconds = sql`(unixepoch() * 1000)`;

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  singletonKey: integer('singleton_key').notNull().default(1),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  passwordChangedAt: integer('password_changed_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lastFailedLoginAt: integer('last_failed_login_at', { mode: 'timestamp_ms' }),
  lockedUntil: integer('locked_until', { mode: 'timestamp_ms' }),
}, (table) => [
  uniqueIndex('users_singleton_idx').on(table.singletonKey),
  uniqueIndex('users_username_idx').on(table.username),
  check('users_singleton_check', sql`${table.singletonKey} = 1`),
]);

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  browser: text('browser').notNull(),
  operatingSystem: text('operating_system').notNull(),
  lastActiveAt: integer('last_active_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
}, (table) => [
  index('devices_user_last_active_idx').on(table.userId, table.lastActiveAt),
]);

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
}, (table) => [
  uniqueIndex('sessions_token_hash_idx').on(table.tokenHash),
  index('sessions_user_expires_idx').on(table.userId, table.expiresAt),
  index('sessions_device_idx').on(table.deviceId),
]);

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  subject: text('subject').notNull(),
  defaultPomodoroTarget: integer('default_pomodoro_target').notNull(),
  defaultTimerPreset: text('default_timer_preset').notNull(),
  notes: text('notes'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  version: integer('version').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
}, (table) => [
  index('tasks_user_updated_idx').on(table.userId, table.updatedAt),
  index('tasks_user_deleted_idx').on(table.userId, table.deletedAt),
  check('tasks_target_check', sql`${table.defaultPomodoroTarget} BETWEEN 1 AND 99`),
  check('tasks_version_check', sql`${table.version} > 0`),
  check('tasks_preset_check', sql`${table.defaultTimerPreset} IN ('25-5', '50-10', 'custom')`),
]);

export const dailyTasks = sqliteTable('daily_tasks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sourceTaskId: text('source_task_id').references(() => tasks.id, { onDelete: 'set null' }),
  date: text('date').notNull(),
  title: text('title').notNull(),
  subject: text('subject').notNull(),
  pomodoroTarget: integer('pomodoro_target').notNull(),
  pomodoroCompleted: integer('pomodoro_completed').notNull().default(0),
  timerPreset: text('timer_preset').notNull(),
  status: text('status').notNull().default('pending'),
  sortOrder: integer('sort_order').notNull().default(0),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  version: integer('version').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
}, (table) => [
  index('daily_tasks_user_date_sort_idx').on(table.userId, table.date, table.sortOrder),
  index('daily_tasks_source_idx').on(table.sourceTaskId),
  index('daily_tasks_user_updated_idx').on(table.userId, table.updatedAt),
  check('daily_tasks_target_check', sql`${table.pomodoroTarget} BETWEEN 1 AND 99`),
  check('daily_tasks_completed_check', sql`${table.pomodoroCompleted} >= 0`),
  check('daily_tasks_version_check', sql`${table.version} > 0`),
  check('daily_tasks_preset_check', sql`${table.timerPreset} IN ('25-5', '50-10', 'custom')`),
  check('daily_tasks_status_check', sql`${table.status} IN ('pending', 'active', 'awaiting_confirmation', 'completed')`),
]);

export const focusSessions = sqliteTable('focus_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  dailyTaskId: text('daily_task_id').references(() => dailyTasks.id, { onDelete: 'set null' }),
  taskTitle: text('task_title').notNull(),
  subject: text('subject').notNull(),
  phase: text('phase').notNull(),
  plannedSeconds: integer('planned_seconds').notNull(),
  effectiveSeconds: integer('effective_seconds').notNull(),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  endedAt: integer('ended_at', { mode: 'timestamp_ms' }).notNull(),
  result: text('result').notNull(),
  interruptionReason: text('interruption_reason'),
  version: integer('version').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
}, (table) => [
  index('focus_sessions_user_started_idx').on(table.userId, table.startedAt),
  index('focus_sessions_daily_task_idx').on(table.dailyTaskId),
  check('focus_sessions_phase_check', sql`${table.phase} IN ('focus', 'short_break', 'long_break')`),
  check('focus_sessions_result_check', sql`${table.result} IN ('completed', 'interrupted', 'abandoned')`),
  check('focus_sessions_duration_check', sql`${table.plannedSeconds} > 0 AND ${table.effectiveSeconds} >= 0`),
  check('focus_sessions_time_check', sql`${table.endedAt} >= ${table.startedAt}`),
  check('focus_sessions_version_check', sql`${table.version} = 1`),
]);

export const activeTimer = sqliteTable('active_timer', {
  id: text('id').primaryKey(),
  singletonKey: integer('singleton_key').notNull().default(1),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  dailyTaskId: text('daily_task_id').notNull().references(() => dailyTasks.id, { onDelete: 'restrict' }),
  phase: text('phase').notNull(),
  status: text('status').notNull(),
  plannedSeconds: integer('planned_seconds').notNull(),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  targetEndAt: integer('target_end_at', { mode: 'timestamp_ms' }).notNull(),
  pausedAt: integer('paused_at', { mode: 'timestamp_ms' }),
  accumulatedPausedSeconds: integer('accumulated_paused_seconds').notNull().default(0),
  interruptionReason: text('interruption_reason'),
  version: integer('version').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
}, (table) => [
  uniqueIndex('active_timer_singleton_idx')
    .on(table.singletonKey)
    .where(sql`${table.deletedAt} IS NULL`),
  uniqueIndex('active_timer_user_idx')
    .on(table.userId)
    .where(sql`${table.deletedAt} IS NULL`),
  check('active_timer_singleton_check', sql`${table.singletonKey} = 1`),
  check('active_timer_phase_check', sql`${table.phase} IN ('focus', 'short_break', 'long_break')`),
  check('active_timer_status_check', sql`${table.status} IN ('running', 'paused')`),
  check('active_timer_duration_check', sql`${table.plannedSeconds} > 0 AND ${table.accumulatedPausedSeconds} >= 0`),
  check('active_timer_version_check', sql`${table.version} > 0`),
  check('active_timer_pause_check', sql`(
    (${table.status} = 'running' AND ${table.pausedAt} IS NULL)
    OR (${table.status} = 'paused' AND ${table.pausedAt} IS NOT NULL)
  )`),
]);

export const conflicts = sqliteTable('conflicts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').references(() => devices.id, { onDelete: 'set null' }),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  conflictType: text('conflict_type').notNull(),
  localOperationId: text('local_operation_id').notNull(),
  baseVersion: integer('base_version').notNull(),
  serverVersion: integer('server_version').notNull(),
  localPayload: text('local_payload', { mode: 'json' }).$type<JsonObject>().notNull(),
  serverPayload: text('server_payload', { mode: 'json' }).$type<JsonObject>().notNull(),
  status: text('status').notNull().default('open'),
  resolution: text('resolution'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
  resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
}, (table) => [
  index('conflicts_open_idx').on(table.userId, table.status, table.createdAt),
  index('conflicts_entity_idx').on(table.entityType, table.entityId),
  check('conflicts_type_check', sql`${table.conflictType} IN ('delete_modify', 'complete_restore', 'archive_add_today', 'timer_divergence')`),
  check('conflicts_entity_type_check', sql`${table.entityType} IN ('task', 'dailyTask', 'focusSession', 'activeTimer', 'settings')`),
  check('conflicts_status_check', sql`${table.status} IN ('open', 'resolved')`),
  check('conflicts_version_check', sql`${table.baseVersion} >= 0 AND ${table.serverVersion} > 0`),
  check('conflicts_payload_check', sql`json_valid(${table.localPayload}) AND json_valid(${table.serverPayload})`),
]);

export const syncOperations = sqliteTable('sync_operations', {
  operationId: text('operation_id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'restrict' }),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  operationType: text('operation_type').notNull(),
  baseVersion: integer('base_version').notNull(),
  payload: text('payload', { mode: 'json' }).$type<JsonObject>().notNull(),
  status: text('status').notNull(),
  entityVersion: integer('entity_version'),
  conflictId: text('conflict_id').references(() => conflicts.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  processedAt: integer('processed_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
}, (table) => [
  index('sync_operations_user_created_idx').on(table.userId, table.createdAt),
  index('sync_operations_device_idx').on(table.deviceId, table.processedAt),
  check('sync_operations_base_version_check', sql`${table.baseVersion} >= 0`),
  check('sync_operations_status_check', sql`${table.status} IN ('applied', 'duplicate', 'conflict')`),
  check('sync_operations_entity_type_check', sql`${table.entityType} IN ('task', 'dailyTask', 'focusSession', 'activeTimer', 'settings')`),
  check('sync_operations_type_check', sql`(
    (${table.entityType} = 'task' AND ${table.operationType} IN ('create', 'update', 'delete', 'archive', 'unarchive'))
    OR (${table.entityType} = 'dailyTask' AND ${table.operationType} IN ('create', 'update', 'delete', 'complete', 'restore', 'addToToday'))
    OR (${table.entityType} = 'focusSession' AND ${table.operationType} = 'create')
    OR (${table.entityType} = 'activeTimer' AND ${table.operationType} IN ('timerStart', 'timerPause', 'timerResume', 'timerComplete', 'timerExit'))
    OR (${table.entityType} = 'settings' AND ${table.operationType} = 'update')
  )`),
  check('sync_operations_payload_check', sql`json_valid(${table.payload})`),
]);

export const syncChanges = sqliteTable('sync_changes', {
  cursor: integer('cursor').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  version: integer('version').notNull(),
  changeType: text('change_type').notNull(),
  payload: text('payload', { mode: 'json' }).$type<JsonObject>(),
  changedAt: integer('changed_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
}, (table) => [
  index('sync_changes_user_cursor_idx').on(table.userId, table.cursor),
  index('sync_changes_entity_idx').on(table.entityType, table.entityId, table.version),
  check('sync_changes_version_check', sql`${table.version} > 0`),
  check('sync_changes_type_check', sql`${table.changeType} IN ('upsert', 'delete')`),
  check('sync_changes_entity_type_check', sql`${table.entityType} IN ('task', 'dailyTask', 'focusSession', 'activeTimer', 'settings')`),
  check('sync_changes_payload_check', sql`(
    (${table.changeType} = 'upsert' AND ${table.payload} IS NOT NULL AND json_valid(${table.payload}))
    OR (${table.changeType} = 'delete' AND ${table.payload} IS NULL)
  )`),
]);

export const settings = sqliteTable('settings', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  defaultPreset: text('default_preset').notNull().default('50-10'),
  customFocusMinutes: integer('custom_focus_minutes').notNull().default(40),
  customShortBreakMinutes: integer('custom_short_break_minutes').notNull().default(8),
  customLongBreakMinutes: integer('custom_long_break_minutes').notNull().default(20),
  longBreakInterval: integer('long_break_interval').notNull().default(4),
  soundEnabled: integer('sound_enabled', { mode: 'boolean' }).notNull().default(true),
  notificationsEnabled: integer('notifications_enabled', { mode: 'boolean' }).notNull().default(false),
  version: integer('version').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(nowInMilliseconds),
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
}, (table) => [
  uniqueIndex('settings_user_idx').on(table.userId),
  check('settings_version_check', sql`${table.version} > 0`),
  check('settings_preset_check', sql`${table.defaultPreset} IN ('25-5', '50-10', 'custom')`),
  check('settings_focus_check', sql`${table.customFocusMinutes} BETWEEN 1 AND 180`),
  check('settings_short_break_check', sql`${table.customShortBreakMinutes} BETWEEN 1 AND 60`),
  check('settings_long_break_check', sql`${table.customLongBreakMinutes} BETWEEN 1 AND 120`),
  check('settings_interval_check', sql`${table.longBreakInterval} BETWEEN 1 AND 12`),
]);

export const schema = {
  activeTimer,
  conflicts,
  dailyTasks,
  devices,
  focusSessions,
  sessions,
  settings,
  syncChanges,
  syncOperations,
  tasks,
  users,
};
