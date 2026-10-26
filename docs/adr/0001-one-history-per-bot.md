# One history per bot across all chats

Each bot has a single history that its DM, every group chat it belongs to, messages from other bots and routine fires all feed into, each input tagged with where it came from. We copied this from Grok Bot instead of giving a bot a separate history per chat, because a bot should remember in its DM what happened in a group chat, and because each bot has one screen, so it can only safely run one thing at a time anyway.

## Consequences

- A bot's work is serialised through one queue with lanes (owner > bot > background); a routine never runs alongside the owner's request.
- Group chat context mixes into the bot's DM history; compaction keeps it bounded, and bots are told never to reveal DM content in group chats.
- This superseded an earlier decision (2026-10-19) to keep one history per bot per chat.
