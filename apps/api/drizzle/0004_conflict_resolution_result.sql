PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conflicts` (
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
	`resolution_result` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "conflicts_type_check" CHECK("__new_conflicts"."conflict_type" IN ('delete_modify', 'complete_restore', 'archive_add_today', 'timer_divergence')),
	CONSTRAINT "conflicts_entity_type_check" CHECK("__new_conflicts"."entity_type" IN ('task', 'dailyTask', 'focusSession', 'activeTimer', 'settings')),
	CONSTRAINT "conflicts_status_check" CHECK("__new_conflicts"."status" IN ('open', 'resolved')),
	CONSTRAINT "conflicts_version_check" CHECK("__new_conflicts"."base_version" >= 0 AND "__new_conflicts"."server_version" > 0),
	CONSTRAINT "conflicts_payload_check" CHECK(json_valid("__new_conflicts"."local_payload") AND json_valid("__new_conflicts"."server_payload")),
	CONSTRAINT "conflicts_resolution_result_check" CHECK("__new_conflicts"."resolution_result" IS NULL OR json_valid("__new_conflicts"."resolution_result"))
);
--> statement-breakpoint
INSERT INTO `__new_conflicts`("id", "user_id", "device_id", "entity_type", "entity_id", "conflict_type", "local_operation_id", "base_version", "server_version", "local_payload", "server_payload", "status", "resolution", "resolution_result", "created_at", "resolved_at") SELECT "id", "user_id", "device_id", "entity_type", "entity_id", "conflict_type", "local_operation_id", "base_version", "server_version", "local_payload", "server_payload", "status", "resolution", NULL, "created_at", "resolved_at" FROM `conflicts`;--> statement-breakpoint
DROP TABLE `conflicts`;--> statement-breakpoint
ALTER TABLE `__new_conflicts` RENAME TO `conflicts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `conflicts_open_idx` ON `conflicts` (`user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `conflicts_entity_idx` ON `conflicts` (`entity_type`,`entity_id`);
