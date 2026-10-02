# Find messages that @ you, in the search we already have

9 September 2026. Isolated Worker only. Not Desk. Not DIE Track Room.
Overlay `/room` waits until `foot-latest.js` is idle. Durable Object not reset.
No hosted model. Catch-up stays a badge.

## Why this is useful

Addressing is the product: humans talk in one room, and `@Name` is how you
talk to a person or an agent. The timeline already tints a row when it
mentions **you**. There is no way to **find** those rows later.

Search today is a literal substring over body + author name. It does not
know about `@`, Talking-to, or “me.” If Maya addressed you an hour ago, you
scroll or guess a word.

That is the Discord **Mentions** tab / Slack `to:me` job. We already have a
search panel. Do not add a second inbox. Catch-up is opt-in; this filter is
opt-in too.

## Research this round

| Source | Lesson |
| --- | --- |
| [Discord search 2025-12](https://support.discord.com/hc/en-us/articles/115000468588-How-to-Use-Search-on-Discord) | Filter **Mentions a specific user**. Shortcut `mentions:` in the same search bar. Mobile: **Mention someone**. Search is a filter on the channel, not a new home. |
| Discord Inbox FAQ (2026-08) | Mentions live under Inbox as an **opt-in** surface. We already reversed Catch-up auto-open. Do **not** copy Inbox-as-landing. Put mentions on the existing search. |
| Slack Activity (Jan 2026) | Mentions, reactions, threads in one Activity feed. Useful at Slack scale; here it would fight “chat is home.” Use search, not a new Activity tab. |
| Slack `to:me` / `@me` | `to:me` finds messages directed at you. `@me` in search is the same job. Keep a typed shortcut **and** a clickable chip so you do not have to remember operators. |
| Slack “shrinking the haystack” | Filters sit **on** search. Clickable chips mirror operators. We add one chip, one operator family. |
| Discrub / Discord profile 2026 | **Filter messages mentioning [name]** is a first-class narrowing of the channel. Ours is only “mentioning **you**” this slice — not a public directory of anyone’s mentions. |
| Hermes / OpenClaw 2026 | Agents hear **explicit @ only**. This filter lists messages that addressed you. It does **not** start inference, even if you are an Agent. |

## Product decision

Reuse `#search-form`. One chip, one helper, same results list.

1. **Mentioned you** (`#search-mentions`, `aria-pressed`) next to Search room.
   Pressed with an empty box lists messages that address the current member.
2. A message addresses you when **either**:
   - the body `@`-mentions your display name (`messageMentionsMember`), or
   - Talking-to is you (`toMemberId`).
   Talking-to without `@` still counts — that is how this room addresses.
3. Typed shortcuts at the **start** of the query, same as the chip:  
   `mentions:me` · `to:me` · `@me`  
   Optional extra words after still filter those hits. `@meow` is **not** a
   shortcut (need a boundary after `@me`).
4. Mentions-only hides work results. This list is chat.
5. Empty chip + empty box → no panel (today’s calm search). Clear turns the
   chip off too.
6. Do not open Catch-up. Do not mark read. Do not run a model. Do not search
   other rooms. Do not add `from:`, `has:`, or `@everyone`.

Work-request modes and thread composer are unchanged.

## Checklist — this change

- [x] Pure `parseSearchQuery(query)` → `{ term, mentionsOnly }`.
- [x] Pure `messageAddressesMember(message, member)` for `@` **or** Talking-to.
- [x] `searchMessages(state, query, limit = 50, { viewer, mentionsOnly })`
      keeps today’s 3-arg calls. Empty term + mentions-only returns the
      addressed set, newest first, still capped at `limit`.
- [x] Chip + Clear + results panel. HOW-TO-TEST: Mentioned you.
- [x] Unit tests for shortcuts, Talking-to, `@meow`, empty. Roster forbids a
      new landing. Playwright: chip lists a fixture `@Room owner` line.

## Gated

Slack Activity / Discord Inbox as home, mark-as-read, mailbox, auto-enroll,
`from:` / `has:` / @everyone, Desk, DO reset, overlay door, agent auto-run.

## How to test

1. Hard-refresh. Search stays closed.
2. Have someone `@` you (or Talk-to you) → click **Mentioned you**. That line
   is in the results. Catch-up stays closed. No model starts.
3. Type `mentions:me book` — only addressed-to-you hits that also say book.
4. Clear. Chip off, panel gone, composer still the home.
