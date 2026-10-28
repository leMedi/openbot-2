CREATE TABLE `memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`bot_id` text,
	`tier` text NOT NULL,
	`content` text NOT NULL,
	`importance` integer DEFAULT 3 NOT NULL,
	`source` text NOT NULL,
	`source_bot_id` text,
	`source_bot_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `memories_bot_idx` ON `memories` (`bot_id`);--> statement-breakpoint
ALTER TABLE `bots` ADD `memory_block` text;