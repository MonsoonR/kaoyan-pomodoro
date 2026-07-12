ALTER TABLE `users` ADD `failed_login_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `last_failed_login_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `locked_until` integer;