# Reaction pills belong under the message, not behind “React”

10 September 2026. Isolated Worker only. Not Desk. Not DIE Track Room.
Overlay `/room` waits until `foot-latest.js` is idle. Durable Object not reset.
No new reaction types, no custom emoji, no reaction notifications.

## Why this is useful

The room already has four reactions (👍 ❤️ 🎉 🤔). You cannot see them until
you open a `<details>` labeled **React**. A 👍 from Maya is invisible on the
timeline. Slack, Discord, Sendbird, and Stream all put **used** reaction
pills **under the message**. The picker is extra; the count is not.

That matters here because a reaction is how you acknowledge an agent or a
person **without** `@`-ing them and **without** starting a model. If the
ack is hidden, people reply in the thread instead, and the channel gets
noisy.

## Research this round

| Source | Lesson |
| --- | --- |
| [Discord reactions wiki 2026-08](https://discord.fandom.com/wiki/Reaction) | A reaction is **displayed beneath a message**. Click an existing pill to join it. Add-reaction is a separate control. |
| Discord “How to react” 2026-02 | Desktop: hover toolbar to **add**. The pills themselves stay on the message. Mobile: long-press to add; pills still visible. |
| Slack one-click reactions | Hover shows three quick emoji. **Existing** reactions stay under the message; hover is only for adding. |
| Slack GIF/emoji guide 2026-01 | Hover a pill to see **who**. Click to toggle yours. Do not hide the bar. |
| [Sendbird React reactions](https://sendbird.com/docs/chat/uikit/v3/react/features/reactions) | **Emoji reaction box below the message** when there is data. Add-reaction on hover if empty. Clicking a pill increments/decrements. |
| [Stream Chat RN 2026-09](https://getstream.io/chat/docs/sdk/react-native/guides/customize-message-reactions/) | Keep the set **small and familiar**. One list position so layout does not jump. We already have four types. |
| Stream iOS cookbook | Slack/WhatsApp place reactions **below** the bubble (not iMessage-on-top). We are Slack-shaped: footer, not header. |
| [Discourse chat reactions popup 2026-06](https://meta.discourse.org/t/new-reactions-popup-in-chat/406004) | Hover a pill for names (we already have `title=`). Do not add a new Activity feed of reactions. |
| CometChat 2026 | Reactions are part of the message bubble, not a separate surface. Real-time counts, per-user pressed state. |
| OpenClaw reactions 2026 | Agents may react as ack. Showing pills is how humans see that ack. **Do not** auto-react from this slice. |

## Product decision

We have only four reactions. Showing all four as pills is cheaper than
hover-only add + used-only bar, and it works on touch (hover is a lie on
phones).

1. Replace `<details class="reactions">` with a **group of pills** under the
   body. No disclosure. No “React” summary.
2. All four types always visible. Empty count shows the emoji only.
   Non-zero count shows the number. Your own pick is `aria-pressed="true"`.
   Anyone’s pick gets `.used` so a 👍 you did not press is still obvious.
3. `title` still lists who reacted (same as today). No new popup.
4. Click still toggles via the existing `MESSAGE_REACTION_SET` command.
   Does not @ anyone. Does not run a model. Does not open Catch-up.
5. Keyboard: pills stay in tab order (min 44px). Esc is unchanged
   (no overlay to peel).
6. Do not add custom emoji, super-reactions, reaction notifications, or a
   Slack Activity “Reactions” tab.

## Checklist — this change

- [x] Pure `reactionPills(reactions)` returns the four keys with
      `{ key, symbol, memberIds, count, used }`. Empty input → four unused.
- [x] `messageContent` renders `<div class="reactions" role="group">` of
      those buttons. No `<details>` / `reaction-menu`.
- [x] CSS: flex pills under the body; `.used` filled; pressed keeps today’s
      blue. Drop summary min-height that only existed for the disclosure.
- [x] Tests: helper matrix; roster forbids `details class="reactions"`.
      HOW-TO-TEST: pills visible, click 👍.
- [x] Playwright composer: 👍 on the fixture topic is visible without
      opening anything; click sets `aria-pressed="true"`.

## Gated

Custom emoji, reaction notifications, Activity/Inbox of reactions, auto-react
for agents, mailbox, Desk, DO reset, overlay door.

## How to test

1. Hard-refresh. Every message shows 👍 ❤️ 🎉 🤔 under the text. No **React**
   disclosure.
2. Click 👍. It fills. Someone else’s ❤️ already shows a count without you
   opening a menu.
3. Catch-up stays closed. No model starts. Esc still does not clear the draft.
