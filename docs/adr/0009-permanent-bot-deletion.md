# Deleting a bot is permanent

Deleting a bot removes everything it owns: its DM, history, memory, routines, grants, rules, screen and home folder, with no archive or trash. Messages it left in group chats and other bots' DMs stay, carrying a copy of its name and shown as deleted, because other bots have already read them and removing them would leave gaps in those chats. This reversed an earlier soft-delete design, so tables need real cascades instead of a `deleted_at` column.
