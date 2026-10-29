-- Full-text search over messages' text, for the palette. External content keyed by the messages' rowid: a VACUUM may
-- renumber those, after which `INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')` fixes the index.
CREATE VIRTUAL TABLE `messages_fts` USING fts5(`text`, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER `messages_fts_insert` AFTER INSERT ON `messages` BEGIN
	INSERT INTO `messages_fts`(rowid, `text`) VALUES (new.rowid, new.`text`);
END;--> statement-breakpoint
CREATE TRIGGER `messages_fts_delete` AFTER DELETE ON `messages` BEGIN
	INSERT INTO `messages_fts`(`messages_fts`, rowid, `text`) VALUES ('delete', old.rowid, old.`text`);
END;--> statement-breakpoint
CREATE TRIGGER `messages_fts_update` AFTER UPDATE OF `text` ON `messages` BEGIN
	INSERT INTO `messages_fts`(`messages_fts`, rowid, `text`) VALUES ('delete', old.rowid, old.`text`);
	INSERT INTO `messages_fts`(rowid, `text`) VALUES (new.rowid, new.`text`);
END;--> statement-breakpoint
INSERT INTO `messages_fts`(`messages_fts`) VALUES ('rebuild');
