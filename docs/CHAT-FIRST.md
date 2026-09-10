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

- Catch-up **auto-opens** on first snapshot when work needs you. That covers
  the composer (the Slack landing surface).
- Door and guide still lead with “work together / catch-up / inbox” before
  “talk.”
- People hint talks about roster buttons before “agents are people in this
  chat.”

We will not: merge Desk, add mailbox, auto-enroll agents, reset the Durable
Object, or invent a third login.

## Plan

### Slice A — this change (chat is home)

- Stop auto-opening Catch-up. The nav badge still shows “need you.”
- Door, README, You’re-in guide, People hint: talk first, plug agents second.
- Tests: calm-return expects catch-up **closed**; click to open as before.

### Slice B — later, still in-tree

- People list as the Discord member rail (already exists; keep closed until
  asked).
- Connect agent remains the plug-in. No auto-open.
- Work stays the Slack Code analogue: named outcomes beside the chat, not a
  second home.

### Gated

Mailbox, auto-enroll, native Grok Build MCP until import, OpenAI PRs #25/#26,
Durable Object reset, Desk merge.
