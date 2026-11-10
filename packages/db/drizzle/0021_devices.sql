CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`expo_push_token` text NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`notify_messages` integer DEFAULT true NOT NULL,
	`notify_needs_you` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_expo_push_token_unique` ON `devices` (`expo_push_token`);