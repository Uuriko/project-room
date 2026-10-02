# Fun, usable chat — plan then this slice

9 September 2026. Isolated Worker only. Not Desk. Not DIE Track Room.
Overlay `/room` waits until `foot-latest.js` is idle. Durable Object not reset.

Chat is already home ([CHAT-FIRST.md](CHAT-FIRST.md)). People and agents already
share one member rail ([GROWTH-PLAN.md](GROWTH-PLAN.md)). This slice makes the
**conversation itself** feel more like Slack/Discord so people stay and keep
@-ing named agents — without a tour, a 1:1 agent app, or auto-run inference.

## Research this round

| Source | Lesson |
| --- | --- |
| Ethora chat UX 2026 | Grouped messages hide repeated chrome; **timestamps appear on hover/tap**. Mentions are a distinct color and **tappable**. Reply context sits above the composer (we already have a reply bar). |
| Slack a11y changelog 2026 | Thread timestamps should stay a real control you can land on; hover must not steal focus. |
| Slack vs Discord for work 2026 | Slack retains on **async readable threads**; Discord on presence. We are invite-only Slack-shaped: keep Catch-up a badge, keep threads opt-in. |
| Slack June 2026 drop | Work stays *in* the conversation (Slackbot into the channel). We already plug agents as members, not a sidebar chatbot. |
| Stoat (ex-Revolt) | Bot badge on agent authors (we have Agent). Messages that mention **you** get a highlight. Username/avatar open a member action. |
| Block Buzz / CircleChat / agentchattr 2026 | Humans and agents are the same kind of member. @mention is how you talk to an agent. Auto-inject/runtime is **gated** here (no hosted model). |
| Discord mention autocomplete 2026 | Mentions that are not members must not appear under “matching members.” Our picker already filters to active members. |

What we will not add: voice, density-toggle settings, @everyone, bot marketplace,
implicit “bot already spoke in this thread so it hears everything” (OpenClaw
Slack footgun), mailbox, Desk merge.

## Why this is the next slice

Grouping hid the timestamp. Mentions are colored but dead. You cannot see that
someone @’d you without reading every line. Those three are the cheapest
Slack/Discord “this is a real room” signals left in-tree.

## Checklist — this change

- [x] Grouped messages show a compact time on hover / focus-within (avatar
      column). Name stays clipped so the thread stays scannable. Tests still
      find `.message-meta`.
- [x] `@Name` in a posted message is a tappable chip (`data-mention-id`). Click
      addresses that Person or Agent in the composer. Does not run a model.
- [x] If the body @-mentions the current viewer, the row gets `.mentioned`
      (Stoat-style tint). Helper `messageMentionsMember` is unit-tested.
- [x] HOW-TO-TEST: hover time, click a mention, your-mention highlight.

## Gated (do not start)

Mailbox, auto-enroll, hosted runtime, OpenAI #25/#26, DO reset, Desk, overlay
door, public sign-up, @everyone, voice.

## How to test

1. Hard-refresh the app. Send two messages in a row: the second hides the name;
   hover it to see the time.
2. Post `@Someone`. The chip is violet. Click it: composer gets `@Someone` and
   Talking-to updates. No model starts.
3. Have someone @ you: that row is tinted. Catch-up still stays closed.
