# pi is the agent runtime, behind one package

Bots run on the pi packages (`pi-durable`, `pi-ai`, `pi-mcp`, `pi-env`, and pi-coding-agent's skill loader), and we hand pi everything it already does: durable runs, compaction, provider login, MCP, shell and file tools, deferred tool search, subagents and tool hooks. Only `@openbot/agent` imports pi, so the rest of the codebase depends on our own interfaces. pi is experimental and its APIs change between releases, so every pi package is pinned to the same exact version (1.3.0, the published release, not GitHub main).
