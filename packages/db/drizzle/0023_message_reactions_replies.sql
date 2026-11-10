ALTER TABLE `messages` ADD `reactions` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `reply_to` text;