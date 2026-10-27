-- Written by hand: drizzle-kit also dropped and recreated every index, and recreated `bots_name_unique` on `lower("name")`, which libSQL rejects.
-- Entries from before this migration were all reviewed actions.
DROP INDEX "audit_log_bot_idx";--> statement-breakpoint
ALTER TABLE `audit_log` ALTER COLUMN "verdict" TO "verdict" text;--> statement-breakpoint
CREATE INDEX `audit_log_bot_idx` ON `audit_log` (`bot_id`,`id`);--> statement-breakpoint
ALTER TABLE `audit_log` ADD `kind` text DEFAULT 'action' NOT NULL;
