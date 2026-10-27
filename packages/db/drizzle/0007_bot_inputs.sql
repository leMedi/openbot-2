CREATE TABLE `bot_inputs` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`input_id` text NOT NULL,
	`input` text NOT NULL,
	`position` integer NOT NULL,
	`taken_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bot_inputs_input_unique` ON `bot_inputs` (`bot_id`,`input_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bot_inputs_position_unique` ON `bot_inputs` (`position`);