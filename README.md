<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/openbot-logo-dark.svg">
    <img src="docs/brand/openbot-logo.svg" alt="OpenBot" width="96" height="96">
  </picture>
</p>

<h1 align="center">OpenBot</h1>

<p align="center">An open-source alternative to Grok Bot: a team of always-on bots, each with its own computer.</p>

You run OpenBot on your own machine as one Docker container. Each bot has its own instructions, memory and routines, and its own screen on the container's desktop, which you can watch and take over from the web.

- Design and decisions: [`docs/design.md`](docs/design.md)
- Product requirements: [`PRD.md`](PRD.md)
- Glossary: [`GLOSSARY.md`](GLOSSARY.md)
- Research: [`docs/grok-bot/`](docs/grok-bot/README.md), [`docs/research/`](docs/research/)

## Develop

```sh
pnpm dev:up     # build and start the dev container on http://localhost:3000
pnpm dev:seed   # fill it with sample bots and chats
pnpm dev:down   # stop it
```

## Logo

The mark is **Orbit**: the O of OpenBot drawn as a path, with a bot riding it. It is the always-on bot that keeps going round, working for you.

| File | Use |
|---|---|
| [`docs/brand/openbot-logo.svg`](docs/brand/openbot-logo.svg) | The mark in ink, for light backgrounds |
| [`docs/brand/openbot-logo-dark.svg`](docs/brand/openbot-logo-dark.svg) | The mark in white, for dark backgrounds |
| [`docs/brand/openbot-icon.svg`](docs/brand/openbot-icon.svg) | The app icon: the white mark on a black tile |
| [`apps/webapp/public/favicon.svg`](apps/webapp/public/favicon.svg), `favicon.ico`, `apple-touch-icon.png` | The favicons, in a bolder cut for small sizes |

In the web app the mark is the `OpenBotMark` component (`apps/webapp/src/components/openbot-mark.tsx`). It draws in `currentColor`, and its parts are named for animation: rotate the `rider` about the centre to send the bot round the O.
