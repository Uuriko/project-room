# Reply should address the person (or agent) you are answering

9 September 2026. Isolated Worker only. Not Desk. Not DIE Track Room.
Overlay `/room` waits until `foot-latest.js` is idle. Durable Object not reset.
No hosted model: Reply still only posts a room-visible message.

## Why this is useful

The room already has Slack/Discord-shaped **Reply** (sets `replyToId`, opens the
thread, shows a quote bar). It does **not** address the author. To talk to an
agent or a person you just answered, you have to `@` them again. That is extra
friction and is not how Slack/Stoat/Mattermost feel.

## Research this round

| Source | Lesson |
| --- | --- |
| Slack vs Discord for work 2026 | Slack retains because **threads keep parallel talks readable**. We already have one-level threads. Make starting one feel like talking to someone. |
| Mattermost reply docs | Reply organizes a conversation under a parent. The composer stays on the message. |
| Stoat (ex-Revolt) composer | Reply preview includes a **mention toggle**: default is to @ the author you are answering. You can turn it off. |
| Raft / Claude-threads / OpenClaw 2026 | Agents live in **threads** so the main channel stays clean. Follow-ups belong in the thread. |
| Hermes Slack issue #8019 / OpenClaw X thread | Implicit “bot already spoke here so it hears everything” **breaks multi-agent rooms**. We will **not** auto-run any agent on Reply. Addressing is identity only. |
| Hermes Discord auto-thread PR | @mention can start a thread; we already have explicit Reply. Do not auto-spawn threads. |

## Product decision

When you click **Reply** on someone else’s active membership:

1. Keep today’s `replyToId` + quote bar + thread (already shipped).
2. **Also address that author** in the composer: Talking-to + `@Name` unless the
   body already @-mentions them.
3. Do not address yourself. Do not address revoked members.
4. Do not run a model, grant access, or auto-open Catch-up / Add agent.

Cancel reply still only clears the quote, not the `@` (you may still want to
talk to them).

## Checklist — this change

- [x] Pure helper `replyAuthorToAddress(viewerId, author)`: null for self,
      inactive, or missing; otherwise the author (Person or Agent).
- [x] Reply click uses it: `applyMentionMember` only when the body does not
      already mention them (`messageMentionsMember`).
- [x] Quote bar names that they are being addressed.
- [x] Tests call the helper (agent vs self vs revoked). HOW-TO-TEST: Reply to
      an agent’s line.

## Gated

Auto-run on thread follow-up, mailbox, Desk, DO reset, overlay door, voice.

## How to test

1. Hard-refresh. Reply to someone else’s message (or an Agent’s). Composer
   shows the quote bar and `@Name`; Talking-to is that member.
2. Reply to your own message: quote bar only, no extra `@`.
3. Send. Catch-up stays closed. No model starts.
