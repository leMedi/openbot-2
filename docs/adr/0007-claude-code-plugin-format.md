# Plugins use the Claude Code format, and all skills come from plugins

A plugin is a Claude Code plugin folder (`.claude-plugin/plugin.json`, `skills/*/SKILL.md`, `.mcp.json`), so existing plugins work unmodified and ours work elsewhere. Plugins come from a catalog bundled with each release. Skills exist only inside plugins: the owner does not write standalone skills and bots cannot create or edit skills, which keeps every capability installable, versioned and grantable per bot.

## Amendment (2026-10-28): hosted MCP servers only

A plugin's tool servers are hosted MCP servers only: `.mcp.json` lists `type: "http"` servers by URL, and the loader rejects stdio servers. Nothing a plugin brings runs on the owner's machine, so there are no processes to supervise, run as another user or keep away from bots with root, and the owner authorizes OpenBot with OAuth instead of handing over API keys. The cost is that only services with a hosted MCP server can be plugins, and an existing Claude Code plugin with a stdio server, hooks, commands or agents does not work unmodified. The first catalog is limited to servers with OAuth dynamic client registration (Notion, Linear, ClickUp, Exa); services that need an OAuth app registered in advance (GitHub, Slack, Google) wait for the owner to bring their own client.

## Amendment (2026-11-10): clients registered in advance

A server in `.mcp.json` may carry `oauth` with a client the owner registered in advance (`clientId`, as in Claude Code's own `.mcp.json`, plus our `clientSecret`, `scopes` and `authorizationParams`), its ID and secret given as `${VAR}`s that the server's environment sets. This keeps the catalog free of secrets and lets services without dynamic client registration be plugins, starting with Google's hosted Workspace servers. A plugin whose variables aren't set is left out, so an instance without a Google client simply doesn't offer them.
