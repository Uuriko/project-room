# Project Room growth and refinement plan

9 September 2026. Isolated Worker only. Not Desk (`src/desk-chat`). Not DIE
Track Room. Overlay `/room` door waits until `foot-latest.js` is idle.

This room is **invite-only**. There is no public sign-up, no ads budget, no
mailbox, and no hosted model runtime. Growth here means: people come back to
talk, they invite other people, and they keep agents in the same conversation
instead of bouncing to a 1:1 chatbot.

## Research (what similar products actually do)

| Source | Lesson for this room |
| --- | --- |
| Slack vs Discord community (Bullenweg 2025) | Slack retains on **utility in the channel you already open**. Discord retains on culture and a tiny first screen. Invite-only Slack-like rooms grow by invite conversion and useful return, not viral join pages. |
| Discord first-week churn (Peakbot 2026) | New members leave when the first screen is a firehose. Land on **one chat**, hide the rest. One welcome action, not forty channels. |
| Discord 2026 usage | No algorithmic feed. Chronological chat is the product. People stay because the thread they care about is still there. |
| Post-launch spike retention (ChurnTools 2026) | Value in **under 60 seconds**. No tour. One path. We will not add a 12-step walkthrough (NN/G: linear tours recall 2–3 of 10 features). |
| NN/G empty states | Name status, teach one unused action, one primary control. Already: Write the first one / Start work. Add a **secondary invite** for owners only. |
| Progressive disclosure (userTourKit / NN/G) | Contextual empty states beat tours. Catch-up and People stay closed until asked. |
| Chat UI that keeps people (Ethora 2026, MUI Chat, Stoat) | Consecutive messages from the same author **group**. Date separators. Unread marker. Mentions are a different color and tappable. Composer stays put. |
| Teams / Discord Inbox | Mentions and unreads are **opt-in surfaces**, not the landing screen. We already reversed Catch-up auto-open. Keep that. |
| NanoClaw Slack (Aug 2026) | Each agent gets its **own identity** in the member list and can be messaged. Persistence beats a disposable chatbot. |
| Slackbot MCP | Tools come **into** the conversation. Identity is a bot, not the human’s token. |
| Duolingo Slack agent / OpenClaw Discord | In a shared channel, agents speak when **@mentioned**. Auto-reply to every line is how bots get kicked. |
| Discord bots (docs, Top.gg, CSCW) | Bots grow because they look like members (APP/BOT tag), install once, and live in the list. Directory/marketplace is **not** this product. |
| Indie SaaS communities (DEV 2026) | First 100 members come from the founder inviting people they already talk to. Off-topic chat retains; weekly digest is later. |

Shared pattern we already chose in [CHAT-FIRST.md](CHAT-FIRST.md): **do not send
people to a 1:1 agent app.** Humans talk in one room. Agents join as named
members.

## Honest growth model

```
Invite a person  →  they talk within a minute  →  they come back for unread chat
                 →  they @ an agent that already has a name
Owner            →  Add agent once  →  agent stays in People  →  humans @ it
```

What we will **not** do in this plan (gated or wrong product):

- Public sign-up, SEO landing, paid ads, CMC, Magic Eden
- Real mailbox / send / drip email
- Auto-enroll Instinct / Muse / Grok Bot, or run a hosted model
- Merge Desk, OpenAI PRs #25/#26, Durable Object reset
- Product tour, sample messages in the live Commons DO
- Auto-open Catch-up, People, or Add agent
- Third login (SSO / email)
- Overlay `/room` copy while `foot-latest.js` is dirty
- Spend

GitHub About + homepage remains a **John paste** in Settings.

## Design principles (keep)

1. Chat is home. Work, results, catch-up, inbox, history are secondary.
2. One primary action per empty state.
3. Agents are people in the member rail, with an Agent badge in chat.
4. Addressing an agent does not run it and does not grant access.
5. Isolated Worker only.

## Checklist

### A — Chat density (Slack/Discord scanability) — this change

- [x] Group consecutive messages from the same author within 7 minutes (hide
      repeated avatar/name; keep the node for focus/tests).
- [x] Date separator on the first message of a local calendar day.
- [x] Session unread line: first message that arrived while you were scrolled
      up. Clears when you jump to latest. Does not rewrite the Durable Object.
- [x] Denser grouped padding. Agent badge already shipped in Slice B.

### B — Addressing (agent retention) — this change

- [x] Type `@` in the composer to pick a Person or Agent. Fills **Talking to**
      and inserts `@Name`. Enter in the picker confirms; it does not send.
- [x] Highlight `@Name` in posted messages when it matches a member.
- [x] Placeholder: “Write to the room… @ to address someone”.
- [x] Guide: chat, @, invite, plug agents from People.

### C — People rail (Discord members) — this change

- [x] Group the list: **People** then **Agents**. Active before revoked.
- [ ] Keep Person / Agent / access revoked labels from Slice B.
- [ ] Add agent stays owner-only, closed until clicked.

### D — Invite loop (human growth) — this change

- [x] Empty chat: primary **Write the first one**. Owner also gets
      **Invite someone** (one extra text button, not a tour).
- [ ] Invite remains the header primary for owners. Guest copy already says
      eight hours. No new credential.

### E — Return loop — already shipped, keep

- [x] Catch-up is a badge, not the landing screen (PR #46).
- [x] Jump-to-latest button when new messages arrive off-screen.
- [x] Session unread divider (A) is the in-chat complement.

### F — Copy / how-to — this change

- [x] HOW-TO-TEST: @ addressing, empty-chat Invite, People/Agents groups.
- [x] This document is the working plan.

### G — Later, still in-tree (not this PR)

- [ ] Door `/room` copy: “Talk with people here. Plug AI agents…” once overlay
      is idle.
- [ ] GitHub About paste (John): Description `Shared room for people and agents. Invite-only.` Website `https://www.trydemigod.com/room`.
- [ ] Composer: click a People row to @ them (optional; @ picker covers it).
- [ ] Work panel as Slack Code analogue: keep it beside chat, do not make it home.

### H — Gated (do not start)

- [ ] Real mailbox / send
- [ ] Auto-enroll agents / native Grok Build until import
- [ ] OpenAI PRs #25/#26
- [ ] Durable Object reset
- [ ] Desk merge
- [ ] Public directory of agents
- [ ] Analytics pixels / email capture

## How to test this change

1. Hard-refresh https://project-room-staging.getdasha.workers.dev
2. Room key → Enter room. Chat is still the first surface.
3. Consecutive messages from you collapse to one name.
4. Scroll up, have another tab post (or wait for a snapshot): a **New messages**
   line appears; **jump to latest** clears it.
5. Type `@` — pick a person or agent. Talking-to updates. Send. The name is
   highlighted. Addressing still does not run an agent.
6. People panel: People group, then Agents. **Add agent** if you are the owner.
7. Empty chat (or a new room): Write the first one; owner also sees Invite someone.

## Proof

Core `node --test` plus conversation unit tests for clustering and mentions.
Browser: composer, first-use, calm-return as needed. No DO reset.
