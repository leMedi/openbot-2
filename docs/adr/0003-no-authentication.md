# No authentication; reached over Tailscale

OpenBot has no login. An instance belongs to one owner and is expected to run on a private host reachable only over Tailscale, so anyone who can reach the port is the owner. All owner resolution goes through a single `getOwner(request)` seam so authentication can be added in one place later.

## Consequences

- Bots on the same computer can call OpenBot's own API (approve their own requests, change settings). Accepted for now; the planned fix is a firewall rule rejecting the bot user's connections to the server port.
- System credentials are never returned by any API, so an unauthenticated caller can use but not read them.
