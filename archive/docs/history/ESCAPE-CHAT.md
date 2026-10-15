# Escape should peel chat overlays, not nuke the draft

9 September 2026. Isolated Worker only. Not Desk. Not DIE Track Room.
Overlay `/room` waits until `foot-latest.js` is idle. Durable Object not reset.

We now have Slack-shaped **Reply** (quote + address the author) and **threads**.
There is no keyboard way to back out except Cancel / ← Back. Discord and Slack
both use **Esc** as “leave this layer.”

## Research this round

| Source | Lesson |
| --- | --- |
| Slack 2026 shortcuts | Esc dismisses dialogs. Esc with no menu marks the channel read. **Close thread** is Esc when the thread pane is open. Do **not** copy “mark read” here (Catch-up is opt-in). |
| Discord 2026 shortcuts | Esc = cancel message **or** mark channel read. Pickers close on Esc without inserting. |
| Rocket.Chat #32861 | Esc while in a thread must **cancel the inner action first** (edit/reply), not close the whole thread. Second Esc can leave the thread. |
| Stack Overflow Esc-clears-draft | Esc must **not** wipe composer text. Drafts stay. |
| Block Buzz desktop | Leaving a thread keeps the channel timeline; jump-to-latest still works. |

## Product decision

One helper, one priority list. Esc never clears the message box.

1. Any `<dialog open>` → do nothing (native dialog / Actions / invite win).
2. Mention picker open → hide it (already true on the textarea; make it the first chat action).
3. Quote bar open (replying to a specific line, not “just in the thread”) → **Cancel reply** only. Keep `@` and body.
4. Inside a thread → **Back to room**. Thread draft stays in `ConversationDrafts`.
5. Otherwise → nothing.

Do not mark messages read. Do not run a model. Do not auto-open Catch-up.

## Checklist — this change

- [x] Pure `escapeChatAction({ dialogOpen, mentionOpen, replyOpen, inThread })`
      returns `null | "hide-mentions" | "clear-reply" | "leave-thread"` in that
      order. Unit tests cover each layer and “draft is not an input.”
- [x] Composer and room keydown (when no dialog) run that helper.
- [x] HOW-TO-TEST: Esc closes @ picker, then quote bar, then thread.

## Gated

Mark-as-read on Esc, edit-last-message on Up, slash-command palette, Desk, DO
reset, overlay door.

## How to test

1. Type `@` so the picker opens → Esc. Picker gone, text remains.
2. Reply to someone → Esc. Quote bar gone, `@Name` and draft remain.
3. Open a thread → Esc. Back on the room list of messages. Catch-up stays closed.
