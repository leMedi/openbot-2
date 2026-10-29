CREATE TABLE `sections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `sections` (`id`, `name`, `position`) VALUES ('unassigned', NULL, 0);--> statement-breakpoint
ALTER TABLE `chats` ADD `section_id` text REFERENCES sections(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `hidden_at` integer;
