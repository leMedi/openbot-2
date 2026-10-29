# Plugin catalog

The plugins bundled with each release (design §5.5, ADR 0007): one Claude Code plugin folder each, read by
`@openbot/plugins` on boot. A plugin brings hosted MCP servers (`.mcp.json`, `type: "http"` with a `url` only) and
optional skills (`skills/<skill>/SKILL.md`); `plugin.json`'s `displayName` and `icon` are what Settings → Plugins shows.
Hooks, commands, agents and config fields are ignored, and a stdio server refuses the plugin.

The icons are each service's own mark (Simple Icons, CC0; Exa's from LobeHub Icons, MIT) on a tile in its brand colours, as its app icon shows it.
