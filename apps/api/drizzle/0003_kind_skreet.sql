PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sync_operations` (
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
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`processed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`conflict_id`) REFERENCES `conflicts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sync_operations_base_version_check" CHECK("__new_sync_operations"."base_version" >= 0),
	CONSTRAINT "sync_operations_status_check" CHECK("__new_sync_operations"."status" IN ('applied', 'conflict', 'rejected')),
	CONSTRAINT "sync_operations_result_check" CHECK((
    ("__new_sync_operations"."status" = 'applied' AND "__new_sync_operations"."entity_version" IS NOT NULL AND "__new_sync_operations"."conflict_id" IS NULL AND "__new_sync_operations"."error_code" IS NULL AND "__new_sync_operations"."error_message" IS NULL)
    OR ("__new_sync_operations"."status" = 'conflict' AND "__new_sync_operations"."conflict_id" IS NOT NULL AND "__new_sync_operations"."error_code" IS NULL AND "__new_sync_operations"."error_message" IS NULL)
    OR ("__new_sync_operations"."status" = 'rejected' AND "__new_sync_operations"."conflict_id" IS NULL AND "__new_sync_operations"."error_code" IS NOT NULL AND "__new_sync_operations"."error_message" IS NOT NULL)
  )),
	CONSTRAINT "sync_operations_entity_type_check" CHECK("__new_sync_operations"."entity_type" IN ('task', 'dailyTask', 'focusSession', 'activeTimer', 'settings')),
	CONSTRAINT "sync_operations_type_check" CHECK((
    ("__new_sync_operations"."entity_type" = 'task' AND "__new_sync_operations"."operation_type" IN ('create', 'update', 'delete', 'archive', 'unarchive'))
    OR ("__new_sync_operations"."entity_type" = 'dailyTask' AND "__new_sync_operations"."operation_type" IN ('create', 'update', 'delete', 'complete', 'restore', 'addToToday'))
    OR ("__new_sync_operations"."entity_type" = 'focusSession' AND "__new_sync_operations"."operation_type" = 'create')
    OR ("__new_sync_operations"."entity_type" = 'activeTimer' AND "__new_sync_operations"."operation_type" IN ('timerStart', 'timerPause', 'timerResume', 'timerComplete', 'timerExit'))
    OR ("__new_sync_operations"."entity_type" = 'settings' AND "__new_sync_operations"."operation_type" = 'update')
  )),
	CONSTRAINT "sync_operations_payload_check" CHECK(json_valid("__new_sync_operations"."payload"))
);
--> statement-breakpoint
INSERT INTO `__new_sync_operations`("operation_id", "user_id", "device_id", "entity_type", "entity_id", "operation_type", "base_version", "payload", "status", "entity_version", "conflict_id", "error_code", "error_message", "created_at", "processed_at") SELECT "operation_id", "user_id", "device_id", "entity_type", "entity_id", "operation_type", "base_version", "payload", CASE WHEN "status" = 'duplicate' THEN 'applied' ELSE "status" END, "entity_version", "conflict_id", NULL, NULL, "created_at", "processed_at" FROM `sync_operations`;--> statement-breakpoint
DROP TABLE `sync_operations`;--> statement-breakpoint
ALTER TABLE `__new_sync_operations` RENAME TO `sync_operations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `sync_operations_user_created_idx` ON `sync_operations` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sync_operations_device_idx` ON `sync_operations` (`device_id`,`processed_at`);
