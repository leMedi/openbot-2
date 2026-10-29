# Plugin catalog

The plugins bundled with each release (design §5.5, ADR 0007): one Claude Code plugin folder each, read by
`@openbot/plugins` on boot. A plugin brings hosted MCP servers (`.mcp.json`, `type: "http"` with a `url` only) and
optional skills (`skills/<skill>/SKILL.md`); `plugin.json`'s `displayName` and `icon` are what Settings → Plugins shows, and its
`keywords` what else the service is known by (a category, the things it holds: `tickets`, `crm`, `meeting notes`), which
`search_plugins` and Settings → Plugins search, since a bot looking for tickets won't say ClickUp.
Hooks, commands, agents and config fields are ignored, and a stdio server refuses the plugin.

Every server signs in with OAuth through dynamic client registration and accepts both the loopback redirect and an
https one (design §5.5 lists the servers left out, and why).

The icons are each service's own mark on a tile, as its app icon shows it: from Simple Icons (CC0) on the service's
brand colour, from LobeHub Icons (MIT) for Exa and Tavily, otherwise the service's own app icon or favicon, embedded in
`logo.svg`.
