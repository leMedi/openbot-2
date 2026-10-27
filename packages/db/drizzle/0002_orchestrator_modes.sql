-- SQLite can't add a NOT NULL column without a default; nothing wrote audit entries before this migration.
ALTER TABLE `audit_log` ADD `tool` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `bots` ADD `orchestrator_modes` text DEFAULT '{}' NOT NULL;
