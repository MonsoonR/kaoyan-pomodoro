CREATE TEMP TABLE `__multi_user_guard` (
	`value` integer NOT NULL CHECK (`value` = 0)
);
--> statement-breakpoint
INSERT INTO `__multi_user_guard` (`value`)
SELECT CASE WHEN count(*) <= 1 THEN 0 ELSE count(*) END FROM `users`;
--> statement-breakpoint
INSERT INTO `__multi_user_guard` (`value`)
SELECT
	(SELECT count(*) FROM `tasks` t LEFT JOIN `users` u ON u.`id` = t.`user_id` WHERE u.`id` IS NULL) +
	(SELECT count(*) FROM `daily_tasks` d LEFT JOIN `users` u ON u.`id` = d.`user_id` WHERE u.`id` IS NULL) +
	(SELECT count(*) FROM `focus_sessions` f LEFT JOIN `users` u ON u.`id` = f.`user_id` WHERE u.`id` IS NULL) +
	(SELECT count(*) FROM `active_timer` a LEFT JOIN `users` u ON u.`id` = a.`user_id` WHERE u.`id` IS NULL) +
	(SELECT count(*) FROM `settings` s LEFT JOIN `users` u ON u.`id` = s.`user_id` WHERE u.`id` IS NULL) +
	(SELECT count(*) FROM `conflicts` c LEFT JOIN `users` u ON u.`id` = c.`user_id` WHERE u.`id` IS NULL) +
	(SELECT count(*) FROM `sync_operations` o LEFT JOIN `users` u ON u.`id` = o.`user_id` WHERE u.`id` IS NULL) +
	(SELECT count(*) FROM `sync_changes` c LEFT JOIN `users` u ON u.`id` = c.`user_id` WHERE u.`id` IS NULL) +
	(SELECT count(*) FROM `devices` d LEFT JOIN `users` u ON u.`id` = d.`user_id` WHERE u.`id` IS NULL) +
	(SELECT count(*) FROM `sessions` s LEFT JOIN `users` u ON u.`id` = s.`user_id` WHERE u.`id` IS NULL);
--> statement-breakpoint
INSERT INTO `__multi_user_guard` (`value`)
SELECT
	(SELECT count(*) FROM `daily_tasks` d JOIN `tasks` t ON t.`id` = d.`source_task_id` WHERE d.`source_task_id` IS NOT NULL AND d.`user_id` <> t.`user_id`) +
	(SELECT count(*) FROM `focus_sessions` f JOIN `daily_tasks` d ON d.`id` = f.`daily_task_id` WHERE f.`daily_task_id` IS NOT NULL AND f.`user_id` <> d.`user_id`) +
	(SELECT count(*) FROM `active_timer` a JOIN `daily_tasks` d ON d.`id` = a.`daily_task_id` WHERE a.`user_id` <> d.`user_id`) +
	(SELECT count(*) FROM `sessions` s JOIN `devices` d ON d.`id` = s.`device_id` WHERE s.`user_id` <> d.`user_id`) +
	(SELECT count(*) FROM `conflicts` c JOIN `devices` d ON d.`id` = c.`device_id` WHERE c.`device_id` IS NOT NULL AND c.`user_id` <> d.`user_id`) +
	(SELECT count(*) FROM `sync_operations` o JOIN `devices` d ON d.`id` = o.`device_id` WHERE o.`user_id` <> d.`user_id`) +
	(SELECT count(*) FROM `sync_operations` o JOIN `conflicts` c ON c.`id` = o.`conflict_id` WHERE o.`conflict_id` IS NOT NULL AND o.`user_id` <> c.`user_id`);
--> statement-breakpoint
DROP TABLE `__multi_user_guard`;
--> statement-breakpoint
ALTER TABLE `users` ADD `normalized_username` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `role` text DEFAULT 'user' NOT NULL CHECK (`role` IN ('admin', 'user'));
--> statement-breakpoint
ALTER TABLE `users` ADD `status` text DEFAULT 'active' NOT NULL CHECK (`status` IN ('active', 'disabled'));
--> statement-breakpoint
ALTER TABLE `users` ADD `must_change_password` integer DEFAULT false NOT NULL CHECK (`must_change_password` IN (0, 1));
--> statement-breakpoint
UPDATE `users`
SET `normalized_username` = normalize_username(`username`),
	`role` = 'admin',
	`status` = 'active',
	`must_change_password` = false;
--> statement-breakpoint
DROP INDEX `users_singleton_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_normalized_username_idx` ON `users` (`normalized_username`);
--> statement-breakpoint
DROP INDEX `active_timer_singleton_idx`;
--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by` text,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`used_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "invitations_expiry_check" CHECK("invitations"."expires_at" > "invitations"."created_at"),
	CONSTRAINT "invitations_usage_check" CHECK(("invitations"."used_at" IS NULL AND "invitations"."used_by" IS NULL) OR ("invitations"."used_at" IS NOT NULL AND "invitations"."used_by" IS NOT NULL)),
	CONSTRAINT "invitations_terminal_state_check" CHECK("invitations"."used_at" IS NULL OR "invitations"."revoked_at" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_hash_idx` ON `invitations` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `invitations_created_by_created_idx` ON `invitations` (`created_by`,`created_at`);
--> statement-breakpoint
CREATE INDEX `invitations_active_idx` ON `invitations` (`expires_at`,`used_at`,`revoked_at`);
--> statement-breakpoint
PRAGMA foreign_key_check;
