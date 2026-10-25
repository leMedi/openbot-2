CREATE TABLE `bots` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`title` text,
	`instructions` text NOT NULL,
	`avatar_type` text DEFAULT 'bot' NOT NULL,
	`bot_color` text NOT NULL,
	`bot_fg_color` text NOT NULL,
	`model` text,
	`deleted_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bots_handle_unique` ON `bots` (`handle`);--> statement-breakpoint
CREATE TABLE `conversation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`author_bot_id` text,
	`content` text NOT NULL,
	`delivery_status` text,
	`source_task_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_messages_source_task_id_unique` ON `conversation_messages` (`source_task_id`);--> statement-breakpoint
CREATE INDEX `conversation_messages_conversation_idx` ON `conversation_messages` (`conversation_id`,`id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`participants` text DEFAULT '[]' NOT NULL,
	`max_runs_per_bot` integer DEFAULT 1 NOT NULL,
	`max_turns_per_message` integer DEFAULT 10 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
