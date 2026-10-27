# No authentication; private networks only

OpenBot has no login. An instance belongs to one owner and is expected to run on a private network, so anyone who can reach the port is the owner. How the network is kept private (a home LAN, a VPN, a firewall) is the owner's business: OpenBot knows nothing about it and ships no network setup. Securing or protecting ports is not a priority for now. All owner resolution goes through a single `getOwner(request)` seam so authentication can be added in one place later.

## Consequences

- Bots on the same computer can call OpenBot's own API (approve their own requests, change settings). Accepted for now; the planned fix is a firewall rule rejecting the bot user's connections to the server port.
- System credentials are never returned by any API, so an unauthenticated caller can use but not read them.
- Served over plain HTTP on anything but `localhost`, the browser treats OpenBot as an insecure context, so clipboard and microphone access don't work there. HTTPS, if wanted, comes from whatever the owner puts in front of it.
