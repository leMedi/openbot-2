# OpenBot

OpenBot gives one person a team of always-on bots that run on a machine they control. Each bot has its own instructions, memory and routines, and its own screen they can watch and take over.

## Language

### People and bots

**Owner**:
The one person an OpenBot instance belongs to. There are no other users.
_Avoid_: User, admin, account

**Bot**:
A named, long-lived agent with its own instructions, memory, routines and screen, that the owner chats with. Its name is unique, ignoring case, and is how the owner and other bots mention it (`@Rex`).
_Avoid_: Agent, assistant

**Instructions**:
The owner-written description of who a bot is and how it behaves.
_Avoid_: Persona, system prompt

### Talking

**Message**:
Something the owner or a bot posts in a chat, readable by everyone in that chat; a bot may also send one straight to another bot, which then appears in both bots' DMs. A bot's history, thinking and tool use are private and never messages.
_Avoid_: Memo, agent message, bubble

**Attachment**:
A file posted with a message: one the owner sends, saved in the bot's uploads folder on the computer, or one a bot sends from the computer. The owner downloads it as it was when posted.
_Avoid_: Upload (for the message's file), asset

**Chat**:
Anything the owner sees and talks in: a DM or a group chat.
_Avoid_: Conversation, room, thread

**DM**:
The chat between the owner and one bot. Every bot has exactly one.
_Avoid_: Direct chat, 1:1, main conversation

**Group chat**:
A chat between the owner and two or more bots, played in rounds where bots may pass.
_Avoid_: Room, channel, group conversation

**History**:
A bot's single private record of everything it has seen and done across all its chats, messages from other bots, and routines; what its model reads.
_Avoid_: Conversation, transcript, context

**Pass**:
A bot choosing to say nothing on its turn in a group chat.

**Round**:
One pass through a group chat's members after a message, each taking a turn in order; a message is answered in at most 3 rounds and 10 turns, and a round in which nobody speaks ends it.
_Avoid_: Cycle, pass (for the round)

**Turn**:
One member's go in a round of a group chat: it reads what others said since its last turn and posts up to two messages, or passes.
_Avoid_: Run (for the turn), reply

**Lane**:
The priority class of a bot's pending work: owner, bot, or background (routines and revivals), in that order. A bot works on one thing at a time; the owner's messages join its current work (unless it is a turn in a group chat, which they wait for), and everything else waits. Turns in group chats are in the owner lane.

**Teammate**:
Another of the owner's bots, as a bot sees it: one it can message.
_Avoid_: Agent, colleague

**Priority message**:
A message from one bot to another that goes ahead of the recipient's other waiting work and interrupts its bot or background work, which it picks up again once. It never interrupts work for the owner.
_Avoid_: Urgent message

### Approvals and access

**Card**:
An interactive item in a chat that asks the owner for something: a choice, an approval, a secret, or a take-over.
_Avoid_: Widget, prompt

**Approval**:
The owner's yes or no on a card asking to let a bot do something.

**Grant**:
A standing permission for one bot to use one thing (a plugin account, a vault item), created by an approval and revocable.
_Avoid_: Permission, access

**Take over**:
The owner controlling a bot's screen directly to unblock it, ending with **hand back**. A bot stuck on its screen asks for one on a **take-over card**; while the owner holds the screen, the bot's computer-use sessions wait.
_Avoid_: Remote control, box help, handoff

### The machine

**Computer**:
The one machine all bots share, with a common filesystem and tools that bots fully control.
_Avoid_: Box, container, VM, sandbox

**Screen**:
A bot's own desktop on the computer, with its own browser and desktop apps, which the owner can watch and take over.
_Avoid_: Display, desktop, window, VNC

**Computer-use session**:
A bot handing one goal to a helper that works its screen (browser and desktop apps) and reports back a summary; the only way a bot clicks, types or sees its screen. Started with a stated reason, reviewed and logged, and never shown in the chat.
_Avoid_: Browser agent, subagent (in the UI), autopilot

**Desktop apps**:
The apps on a bot's screen other than its web pages (an editor, its browser's own window), which a computer-use session drives through their accessibility trees.
_Avoid_: GUI, native apps; "desktop" alone for the screen itself

**Effect**:
What a desktop action did, as far as the screen can tell: confirmed (read back), unverifiable (sent, not seen), suspected no-op, partial, or refused (nothing sent). Anything short of confirmed is checked by looking again, never assumed.
_Avoid_: Status, success

### Capabilities

**Plugin**:
An installable bundle of skills, tool servers, or both, giving bots a capability such as Gmail or GitHub.
_Avoid_: Connector, integration, extension

**Plugin account**:
One named sign-in to a plugin's service; a plugin may have several, and the first is called `default`.
_Avoid_: Connection, profile

**Skill**:
A packaged set of instructions that comes from a plugin. There are no other kinds of skill.

**Vault**:
The owner's store of logins, contacts and secrets that bots may use only through grants.
_Avoid_: Keychain, password manager

**Vault item**:
One entry in the vault: a login, a contact, or a secret.

**System credential**:
A credential OpenBot itself holds to reach model providers and plugin accounts; never visible or grantable to bots.
_Avoid_: Vault secret, token

**Provider**:
A model vendor or subscription OpenBot can call, such as OpenAI or Claude Pro.

**Default model**:
The model every bot uses unless it has its own.

### Memory and routines

**Memory**:
Facts a bot keeps across conversations, either its own or shared by all bots (global memory).

**Fact**:
One remembered statement, with a tier: profile (always relevant), log (a dated event) or note (short-lived).

**Routine**:
A note from a bot to its future self plus a schedule; when it fires, the bot wakes and may stay silent.
_Avoid_: Automation, cron job, task

**Reminder**:
A routine that fires once.

### Oversight

**Orchestrator**:
The reviewer that judges a bot's side-effecting actions before they happen, answering allow, deny or ask.
_Avoid_: Auto-review, guard, classifier

**Surface**:
A kind of side effect the orchestrator reviews, such as shell commands or vault use.

**Rule**:
An owner-written sentence telling the orchestrator to allow something automatically or ask first.

**Shadow mode**:
The orchestrator judging and logging actions without ever blocking them.

**Audit log**:
A bot's record of every side-effecting action it took, reviewed or not, and of each page and summary of its computer-use sessions, with secrets redacted. The owner reads it in the Activity pane.
_Avoid_: Action log, history (that is the bot's own record)

### Delivery

**Release**:
A versioned build of OpenBot's code, produced by every push to main and installed in place.

**Runtime image**:
The container image holding OpenBot's operating system and tools, updated rarely and separately from releases.

### Evals

**Eval**:
A developer-only check that bots behave as intended on a real model: a scenario run several times, reported as a pass rate. Never part of the app.
_Avoid_: Test (for an eval), benchmark

**Scenario**:
One eval case: bots and group chats to set up, a fake world, the owner's messages, and the checks a run must pass (assertions and rubric items).
_Avoid_: Test case, fixture

**Suite**:
A folder of scenarios about one behaviour, such as tool priority or voice. The **smoke suite** is the scenarios marked to run in CI.

**Fake world**:
What a scenario's bots act on instead of the real one: scripted shell results, web pages, plugin tools and clock.
_Avoid_: Mock, sandbox

**Rubric item**:
A sentence an eval judge model scores a run on, pass or fail, where no deterministic assertion can tell.
_Avoid_: Criterion, grader

**Pass rate**:
The share of a scenario's runs in which every assertion and rubric item passed; a suite's is its scenarios' mean.
