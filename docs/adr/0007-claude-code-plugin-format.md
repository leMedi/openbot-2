# Plugins use the Claude Code format, and all skills come from plugins

A plugin is a Claude Code plugin folder (`.claude-plugin/plugin.json`, `skills/*/SKILL.md`, `.mcp.json`), so existing plugins work unmodified and ours work elsewhere. Plugins come from a catalog bundled with each release. Skills exist only inside plugins: the owner does not write standalone skills and bots cannot create or edit skills, which keeps every capability installable, versioned and grantable per bot.
