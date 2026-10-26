ALTER TABLE `bots` RENAME COLUMN "persona" TO "instructions";--> statement-breakpoint
DROP INDEX `bots_handle_unique`;--> statement-breakpoint
-- Names are now unique ignoring case; later bots that share a name get a suffix from their id.
UPDATE `bots` SET `name` = `name` || ' ' || substr(`id`, -4) WHERE `id` NOT IN (SELECT min(`id`) FROM `bots` GROUP BY lower(`name`));--> statement-breakpoint
CREATE UNIQUE INDEX `bots_name_unique` ON `bots` (lower("name"));--> statement-breakpoint
ALTER TABLE `bots` DROP COLUMN `handle`;