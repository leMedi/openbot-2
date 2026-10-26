# Browser and desktop control only through a computer-use subagent

A bot cannot click, type or take screenshots itself. It calls one tool, `use_computer({ goal, reason })`, which runs a subagent with its own model and only the browser and desktop tools, working on the bot's screen, and returns a summary. We chose this over giving bots those tools directly because screenshots and accessibility trees would flood the bot's history, and because a required, logged reason makes computer use a deliberate last resort after plugins, shell and web fetch.

## Consequences

- When the subagent is stuck (login, captcha, 2FA) the bot posts a take-over card and waits for the owner to hand the screen back.
- Computer-use sessions are the first surface the orchestrator reviews.
