# Plugin catalog

The plugins bundled with each release (design §5.5, ADR 0007): one Claude Code plugin folder each, read by
`@openbot/plugins` on boot. A plugin brings hosted MCP servers (`.mcp.json`, `type: "http"` with a `url` only) and
optional skills (`skills/<skill>/SKILL.md`); `plugin.json`'s `displayName` and `icon` are what Settings → Plugins shows, and its
`keywords` what else the service is known by (a category, the things it holds: `tickets`, `crm`, `meeting notes`), which
`search_plugins` and Settings → Plugins search, since a bot looking for tickets won't say ClickUp.
Hooks, commands, agents and config fields are ignored, and a stdio server refuses the plugin.

Every server signs in with OAuth through dynamic client registration and accepts both the loopback redirect and an
https one (design §5.5 lists the servers left out, and why), except those whose `oauth` in `.mcp.json` names a client
registered in advance, its ID and secret as `${VAR}`s from the server's environment; such a plugin is left out, with a
warning, until they are set.

## Google (Gmail, Calendar, Drive, Docs, Sheets, Slides)

Google's hosted MCP servers have no dynamic client registration, so they sign in with your own OAuth client:

1. In a Google Cloud project that is in the [Google Workspace Developer Preview Program](https://developers.google.com/workspace/preview),
   enable the APIs of the services you want (Gmail, Calendar, Drive, Docs, Sheets, Slides) and their MCP APIs
   (`gmailmcp`, `calendarmcp`, `drivemcp`, `docsmcp`, `sheetsmcp`, `slidesmcp` `.googleapis.com`).
2. Under Google Auth Platform, set up the consent screen (Branding, Audience: while in testing, add your Google
   accounts as test users) and Data Access (the scopes in each plugin's `.mcp.json`).
3. Create a client of type **Web application**, tick **Use this client for an AI-powered agent**, and add as
   authorized redirect URIs `http://127.0.0.1:8976/callback` (the pasted sign-in, from a private network over plain
   HTTP) and your instance's `<https or localhost origin>/api/plugins/oauth/callback`, e.g.
   `http://localhost:3000/api/plugins/oauth/callback`.
4. Set `OPENBOT_GOOGLE_WORKSPACE_MCP_CLIENT_ID` and `OPENBOT_GOOGLE_WORKSPACE_MCP_CLIENT_SECRET` in the server's environment (`.env`, or `docker/compose.yml`'s
   `.env`) and restart it. Each plugin then connects in Settings → Plugins, one Google account per sign-in.

Google's setup guide: <https://developers.google.com/workspace/guides/configure-mcp-servers>.

The icons are each service's own mark on a tile, as its app icon shows it: from Simple Icons (CC0) on the service's
brand colour, from LobeHub Icons (MIT) for Exa and Tavily, otherwise the service's own app icon or favicon, embedded in
`logo.svg`.
