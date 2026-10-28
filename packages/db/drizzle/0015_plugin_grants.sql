CREATE TABLE `plugin_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`plugin` text NOT NULL,
	`account` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_grants_idx` ON `plugin_grants` (`bot_id`,`plugin`,`account`);--> statement-breakpoint
ALTER TABLE `audit_log` ADD `server` text;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `outcome` text;