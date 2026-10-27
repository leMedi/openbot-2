ALTER TABLE `chats` ADD `last_read_message_id` text;--> statement-breakpoint
-- Chats from before read state existed start read, rather than every one of them lighting up as unread.
UPDATE `chats` SET `last_read_message_id` = (SELECT max(`id`) FROM `messages` WHERE `messages`.`chat_id` = `chats`.`id`);
