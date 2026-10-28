CREATE TABLE `routine_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`routine_id` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`fired_at` integer,
	`status` text NOT NULL,
	`finished_at` integer,
	`message_id` text,
	`test` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `routine_runs_routine_idx` ON `routine_runs` (`routine_id`,`id`);--> statement-breakpoint
CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`schedule` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `routines_bot_idx` ON `routines` (`bot_id`);--> statement-breakpoint
CREATE INDEX `routines_next_run_idx` ON `routines` (`next_run_at`);