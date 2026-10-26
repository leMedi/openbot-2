# One container, and bots have root on the same computer as the server

OpenBot runs as a single container: the server, every bot's screen, and the bots' shell all share one computer, and bots have full passwordless sudo because it is their computer. We chose this over a separate desktop container (or one per bot) for simplicity, local-speed computer use, and a one-service compose file; the server runs as its own Unix user and talks to screens through a `Computer` interface, so the desktop can be split out later.

## Consequences

- With root, bots can read the vault, system credentials and the encryption key. This is accepted until P1, which must add a boundary bots cannot cross (planned: a small secrets-broker container only the server can reach).
