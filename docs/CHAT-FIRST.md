# Chat-first Project Room

9 September 2026. Isolated Worker only. Not Desk (`src/desk-chat`). Not DIE Track Room.

## Core

Two jobs:

1. **Humans talk to humans** in one room (Slack/Discord channel).
2. **Plug AI agents and tools into that same room** as named members, not a
   second product.

Everything else (work, results, catch-up, inbox, history) is secondary.

## What similar products actually do

| Product | Humans | Agents / tools |
| --- | --- | --- |
| **Slack** | Channel is home. Activity/Later is a badge, not the landing screen. | Agents are members you @mention. Slack Code puts long agent work in a **dedicated channel**, not over the main chat. Slackbot MCP pulls tools *into* the conversation. Identity is a bot, not the human’s token. |
| **Discord** | Channel is home. Members list is a rail. | Bots are server members with a name and avatar. Invite once; they live in the member list. |
| **NanoClaw (2026)** | Still Slack. | Each agent gets its own Slack identity. They appear in the sidebar and send messages. |
| **Meta → Slack (2026)** | Switching Chat → Slack because agents need a conversational home plus third-party plug-in. | Same point: chat substrate, then agents. |

Shared pattern: **do not send people to a 1:1 agent app.** Agents join the
multiplayer thread. Catch-up / activity is opt-in.

## What is too much here today

Slice A (PR #46) stopped Catch-up from covering the composer. Slice B is
this change: people look like people, agents look like agents, plug-in is
**Add agent**.

We will not: merge Desk, add mailbox, auto-enroll agents, reset the Durable
Object, or invent a third login.

## Plan

### Slice A — shipped (PR #46, chat is home)

- Stop auto-opening Catch-up. The nav badge still shows “need you.”
- Door, README, You’re-in guide, People hint: talk first, plug agents second.
- Tests: calm-return expects catch-up **closed**; click to open as before.

### Slice B — shipped (Discord member rail)

- People list: **Person** / **Agent** / access revoked. No “kind · presence
  unknown.”
- Chat messages: **Agent** badge on agent authors only (humans stay a name
  and time).
- Plug-in label **Add agent**. Actions: How to add an agent. No auto-open.
- Work stays the Slack Code analogue: named outcomes beside the chat, not a
  second home.

### Growth / refinement

See [GROWTH-PLAN.md](GROWTH-PLAN.md). Chat density, @ addressing, People/Agents
groups, empty-chat invite. Thread composer copy and Also-@ live in
[THREAD-COMPOSER.md](THREAD-COMPOSER.md). Mentioned-you search lives in
[MENTIONS-SEARCH.md](MENTIONS-SEARCH.md). Reaction pills live in
[REACTIONS-VISIBLE.md](REACTIONS-VISIBLE.md). Door copy still waits on overlay idle.

### Gated

Mailbox, auto-enroll, native Grok Build MCP until import, OpenAI PRs #25/#26,
Durable Object reset, Desk merge.
