PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_active_timer` (
	`id` text PRIMARY KEY NOT NULL,
	`singleton_key` integer DEFAULT 1 NOT NULL,
	`user_id` text NOT NULL,
	`daily_task_id` text NOT NULL,
	`task_title` text NOT NULL,
	`subject` text NOT NULL,
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
	CONSTRAINT "active_timer_singleton_check" CHECK("__new_active_timer"."singleton_key" = 1),
	CONSTRAINT "active_timer_phase_check" CHECK("__new_active_timer"."phase" IN ('focus', 'short_break', 'long_break')),
	CONSTRAINT "active_timer_status_check" CHECK("__new_active_timer"."status" IN ('running', 'paused')),
	CONSTRAINT "active_timer_duration_check" CHECK("__new_active_timer"."planned_seconds" > 0 AND "__new_active_timer"."accumulated_paused_seconds" >= 0),
	CONSTRAINT "active_timer_version_check" CHECK("__new_active_timer"."version" > 0),
	CONSTRAINT "active_timer_target_end_check" CHECK("__new_active_timer"."target_end_at" >= "__new_active_timer"."started_at"),
	CONSTRAINT "active_timer_reason_check" CHECK("__new_active_timer"."interruption_reason" IS NULL OR length("__new_active_timer"."interruption_reason") BETWEEN 1 AND 500),
	CONSTRAINT "active_timer_title_check" CHECK(length(trim("__new_active_timer"."task_title")) > 0),
	CONSTRAINT "active_timer_subject_check" CHECK(length(trim("__new_active_timer"."subject")) > 0),
	CONSTRAINT "active_timer_pause_check" CHECK((
    ("__new_active_timer"."status" = 'running' AND "__new_active_timer"."paused_at" IS NULL)
    OR ("__new_active_timer"."status" = 'paused' AND "__new_active_timer"."paused_at" IS NOT NULL)
  ))
);
--> statement-breakpoint
INSERT INTO `__new_active_timer`("id", "singleton_key", "user_id", "daily_task_id", "task_title", "subject", "phase", "status", "planned_seconds", "started_at", "target_end_at", "paused_at", "accumulated_paused_seconds", "interruption_reason", "version", "created_at", "updated_at", "deleted_at") SELECT a."id", a."singleton_key", a."user_id", a."daily_task_id", d."title", d."subject", a."phase", a."status", a."planned_seconds", a."started_at", a."target_end_at", a."paused_at", a."accumulated_paused_seconds", a."interruption_reason", a."version", a."created_at", a."updated_at", a."deleted_at" FROM `active_timer` a JOIN `daily_tasks` d ON d."id" = a."daily_task_id";--> statement-breakpoint
DROP TABLE `active_timer`;--> statement-breakpoint
ALTER TABLE `__new_active_timer` RENAME TO `active_timer`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `active_timer_singleton_idx` ON `active_timer` (`singleton_key`) WHERE "active_timer"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `active_timer_user_idx` ON `active_timer` (`user_id`) WHERE "active_timer"."deleted_at" IS NULL;
--> statement-breakpoint
PRAGMA foreign_key_check;
