CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`surface` text NOT NULL,
	`action` text NOT NULL,
	`verdict` text NOT NULL,
	`mode` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_log_bot_idx` ON `audit_log` (`bot_id`,`id`);--> statement-breakpoint
CREATE TABLE `bots` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`title` text,
	`persona` text DEFAULT '' NOT NULL,
	`avatar_shape` text NOT NULL,
	`avatar_color` text NOT NULL,
	`model` text,
	`history_id` text,
	`display_number` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bots_handle_unique` ON `bots` (`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `bots_history_id_unique` ON `bots` (`history_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bots_display_number_unique` ON `bots` (`display_number`);--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`bot_id` text,
	`title` text,
	`members` text DEFAULT '[]' NOT NULL,
	`pinned_position` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chats_bot_id_unique` ON `chats` (`bot_id`);--> statement-breakpoint
CREATE INDEX `chats_kind_idx` ON `chats` (`kind`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`author` text NOT NULL,
	`author_bot_id` text,
	`author_name` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`attachments` text DEFAULT '[]' NOT NULL,
	`card` text,
	`card_state` text,
	`direction` text,
	`peer_bot_id` text,
	`peer_name` text,
	`idempotency_key` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`peer_bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_idempotency_key_unique` ON `messages` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `messages_chat_idx` ON `messages` (`chat_id`,`id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `system_credentials` (
	`key` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
