CREATE TABLE `plugin_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin` text NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`connected_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`disconnected_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_accounts_slug_idx` ON `plugin_accounts` (`plugin`,`slug`);