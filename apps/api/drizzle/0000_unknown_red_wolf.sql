CREATE TABLE `active_timer` (
	`id` text PRIMARY KEY NOT NULL,
	`singleton_key` integer DEFAULT 1 NOT NULL,
	`user_id` text NOT NULL,
	`daily_task_id` text NOT NULL,
	`phase` text NOT NULL,
	`status` text NOT NULL,
	`planned_seconds` integer NOT NULL,
	`started_at` integer NOT NULL,
	`target_end_at` integer NOT NULL,
	`paused_at` integer,
	`accumulated_paused_seconds` integer DEFAULT 0 NOT NULL,
	`interruption_reason` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`daily_task_id`) REFERENCES `daily_tasks`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "active_timer_singleton_check" CHECK("active_timer"."singleton_key" = 1),
	CONSTRAINT "active_timer_phase_check" CHECK("active_timer"."phase" IN ('focus', 'short_break', 'long_break')),
	CONSTRAINT "active_timer_status_check" CHECK("active_timer"."status" IN ('running', 'paused')),
	CONSTRAINT "active_timer_duration_check" CHECK("active_timer"."planned_seconds" > 0 AND "active_timer"."accumulated_paused_seconds" >= 0),
	CONSTRAINT "active_timer_version_check" CHECK("active_timer"."version" > 0),
	CONSTRAINT "active_timer_pause_check" CHECK((
    ("active_timer"."status" = 'running' AND "active_timer"."paused_at" IS NULL)
    OR ("active_timer"."status" = 'paused' AND "active_timer"."paused_at" IS NOT NULL)
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `active_timer_singleton_idx` ON `active_timer` (`singleton_key`) WHERE "active_timer"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `active_timer_user_idx` ON `active_timer` (`user_id`) WHERE "active_timer"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`conflict_type` text NOT NULL,
	`local_operation_id` text NOT NULL,
	`base_version` integer NOT NULL,
	`server_version` integer NOT NULL,
	`local_payload` text NOT NULL,
	`server_payload` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "conflicts_type_check" CHECK("conflicts"."conflict_type" IN ('delete_modify', 'complete_restore', 'archive_add_today', 'timer_divergence')),
	CONSTRAINT "conflicts_entity_type_check" CHECK("conflicts"."entity_type" IN ('task', 'dailyTask', 'focusSession', 'activeTimer', 'settings')),
	CONSTRAINT "conflicts_status_check" CHECK("conflicts"."status" IN ('open', 'resolved')),
	CONSTRAINT "conflicts_version_check" CHECK("conflicts"."base_version" >= 0 AND "conflicts"."server_version" > 0),
	CONSTRAINT "conflicts_payload_check" CHECK(json_valid("conflicts"."local_payload") AND json_valid("conflicts"."server_payload"))
);
--> statement-breakpoint
CREATE INDEX `conflicts_open_idx` ON `conflicts` (`user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `conflicts_entity_idx` ON `conflicts` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `daily_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_task_id` text,
	`date` text NOT NULL,
	`title` text NOT NULL,
	`subject` text NOT NULL,
	`pomodoro_target` integer NOT NULL,
	`pomodoro_completed` integer DEFAULT 0 NOT NULL,
	`timer_preset` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`completed_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "daily_tasks_target_check" CHECK("daily_tasks"."pomodoro_target" BETWEEN 1 AND 99),
	CONSTRAINT "daily_tasks_completed_check" CHECK("daily_tasks"."pomodoro_completed" >= 0),
	CONSTRAINT "daily_tasks_version_check" CHECK("daily_tasks"."version" > 0),
	CONSTRAINT "daily_tasks_preset_check" CHECK("daily_tasks"."timer_preset" IN ('25-5', '50-10', 'custom')),
	CONSTRAINT "daily_tasks_status_check" CHECK("daily_tasks"."status" IN ('pending', 'active', 'awaiting_confirmation', 'completed'))
);
--> statement-breakpoint
CREATE INDEX `daily_tasks_user_date_sort_idx` ON `daily_tasks` (`user_id`,`date`,`sort_order`);--> statement-breakpoint
CREATE INDEX `daily_tasks_source_idx` ON `daily_tasks` (`source_task_id`);--> statement-breakpoint
CREATE INDEX `daily_tasks_user_updated_idx` ON `daily_tasks` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`browser` text NOT NULL,
	`operating_system` text NOT NULL,
	`last_active_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `devices_user_last_active_idx` ON `devices` (`user_id`,`last_active_at`);--> statement-breakpoint
CREATE TABLE `focus_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`daily_task_id` text,
	`task_title` text NOT NULL,
	`subject` text NOT NULL,
	`phase` text NOT NULL,
	`planned_seconds` integer NOT NULL,
	`effective_seconds` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`result` text NOT NULL,
	`interruption_reason` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`daily_task_id`) REFERENCES `daily_tasks`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "focus_sessions_phase_check" CHECK("focus_sessions"."phase" IN ('focus', 'short_break', 'long_break')),
	CONSTRAINT "focus_sessions_result_check" CHECK("focus_sessions"."result" IN ('completed', 'interrupted', 'abandoned')),
	CONSTRAINT "focus_sessions_duration_check" CHECK("focus_sessions"."planned_seconds" > 0 AND "focus_sessions"."effective_seconds" >= 0),
	CONSTRAINT "focus_sessions_time_check" CHECK("focus_sessions"."ended_at" >= "focus_sessions"."started_at"),
	CONSTRAINT "focus_sessions_version_check" CHECK("focus_sessions"."version" = 1)
);
--> statement-breakpoint
CREATE INDEX `focus_sessions_user_started_idx` ON `focus_sessions` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `focus_sessions_daily_task_idx` ON `focus_sessions` (`daily_task_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_idx` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_expires_idx` ON `sessions` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `sessions_device_idx` ON `sessions` (`device_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`default_preset` text DEFAULT '50-10' NOT NULL,
	`custom_focus_minutes` integer DEFAULT 40 NOT NULL,
	`custom_short_break_minutes` integer DEFAULT 8 NOT NULL,
	`custom_long_break_minutes` integer DEFAULT 20 NOT NULL,
	`long_break_interval` integer DEFAULT 4 NOT NULL,
	`sound_enabled` integer DEFAULT true NOT NULL,
	`notifications_enabled` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "settings_version_check" CHECK("settings"."version" > 0),
	CONSTRAINT "settings_preset_check" CHECK("settings"."default_preset" IN ('25-5', '50-10', 'custom')),
	CONSTRAINT "settings_focus_check" CHECK("settings"."custom_focus_minutes" BETWEEN 1 AND 180),
	CONSTRAINT "settings_short_break_check" CHECK("settings"."custom_short_break_minutes" BETWEEN 1 AND 60),
	CONSTRAINT "settings_long_break_check" CHECK("settings"."custom_long_break_minutes" BETWEEN 1 AND 120),
	CONSTRAINT "settings_interval_check" CHECK("settings"."long_break_interval" BETWEEN 1 AND 12)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settings_user_idx` ON `settings` (`user_id`);--> statement-breakpoint
CREATE TABLE `sync_changes` (
	`cursor` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`version` integer NOT NULL,
	`change_type` text NOT NULL,
	`payload` text,
	`changed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sync_changes_version_check" CHECK("sync_changes"."version" > 0),
	CONSTRAINT "sync_changes_type_check" CHECK("sync_changes"."change_type" IN ('upsert', 'delete')),
	CONSTRAINT "sync_changes_entity_type_check" CHECK("sync_changes"."entity_type" IN ('task', 'dailyTask', 'focusSession', 'activeTimer', 'settings')),
	CONSTRAINT "sync_changes_payload_check" CHECK((
    ("sync_changes"."change_type" = 'upsert' AND "sync_changes"."payload" IS NOT NULL AND json_valid("sync_changes"."payload"))
    OR ("sync_changes"."change_type" = 'delete' AND "sync_changes"."payload" IS NULL)
  ))
);
--> statement-breakpoint
CREATE INDEX `sync_changes_user_cursor_idx` ON `sync_changes` (`user_id`,`cursor`);--> statement-breakpoint
CREATE INDEX `sync_changes_entity_idx` ON `sync_changes` (`entity_type`,`entity_id`,`version`);--> statement-breakpoint
CREATE TABLE `sync_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`operation_type` text NOT NULL,
	`base_version` integer NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`entity_version` integer,
	`conflict_id` text,
	`created_at` integer NOT NULL,
	`processed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conflict_id`) REFERENCES `conflicts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sync_operations_base_version_check" CHECK("sync_operations"."base_version" >= 0),
	CONSTRAINT "sync_operations_status_check" CHECK("sync_operations"."status" IN ('applied', 'duplicate', 'conflict')),
	CONSTRAINT "sync_operations_entity_type_check" CHECK("sync_operations"."entity_type" IN ('task', 'dailyTask', 'focusSession', 'activeTimer', 'settings')),
	CONSTRAINT "sync_operations_type_check" CHECK((
    ("sync_operations"."entity_type" = 'task' AND "sync_operations"."operation_type" IN ('create', 'update', 'delete', 'archive', 'unarchive'))
    OR ("sync_operations"."entity_type" = 'dailyTask' AND "sync_operations"."operation_type" IN ('create', 'update', 'delete', 'complete', 'restore', 'addToToday'))
    OR ("sync_operations"."entity_type" = 'focusSession' AND "sync_operations"."operation_type" = 'create')
    OR ("sync_operations"."entity_type" = 'activeTimer' AND "sync_operations"."operation_type" IN ('timerStart', 'timerPause', 'timerResume', 'timerComplete', 'timerExit'))
    OR ("sync_operations"."entity_type" = 'settings' AND "sync_operations"."operation_type" = 'update')
  )),
	CONSTRAINT "sync_operations_payload_check" CHECK(json_valid("sync_operations"."payload"))
);
--> statement-breakpoint
CREATE INDEX `sync_operations_user_created_idx` ON `sync_operations` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sync_operations_device_idx` ON `sync_operations` (`device_id`,`processed_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`subject` text NOT NULL,
	`default_pomodoro_target` integer NOT NULL,
	`default_timer_preset` text NOT NULL,
	`notes` text,
	`archived` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tasks_target_check" CHECK("tasks"."default_pomodoro_target" BETWEEN 1 AND 99),
	CONSTRAINT "tasks_version_check" CHECK("tasks"."version" > 0),
	CONSTRAINT "tasks_preset_check" CHECK("tasks"."default_timer_preset" IN ('25-5', '50-10', 'custom'))
);
--> statement-breakpoint
CREATE INDEX `tasks_user_updated_idx` ON `tasks` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `tasks_user_deleted_idx` ON `tasks` (`user_id`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`singleton_key` integer DEFAULT 1 NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_changed_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "users_singleton_check" CHECK("users"."singleton_key" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_singleton_idx` ON `users` (`singleton_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_idx` ON `users` (`username`);