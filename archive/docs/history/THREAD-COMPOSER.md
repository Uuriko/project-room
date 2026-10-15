# The composer should know whether you are in the room or in a thread

9 September 2026. Isolated Worker only. Not Desk. Not DIE Track Room.
Overlay `/room` waits until `foot-latest.js` is idle. Durable Object not reset.
No hosted model: this slice only changes composer copy and the Reply quote bar.

## Why this is useful

We already have Slack-shaped threads, Reply that quotes **and** addresses the
author, Esc that peels overlays, and a screen-reader label that says
“Reply in this thread” once you are inside one. The **visible** composer still
lies:

1. `index.html` ships `placeholder="Write to the room… @ to address someone"`.
2. `syncRequestComposer` immediately overwrites that with `"Message…"`.
3. Opening a thread does not change the placeholder, so you can be inside a
   side conversation and still think you are writing to the whole room.

That is the “accidentally replied in the channel” Slack mistake, inverted:
here you think you are in the room while you are in a thread. Sendbird, Slack,
and CometChat all change the input placeholder when the thread pane is open.

Reply also always `@`s the author. Discord, Stoat, and Discordo treat
**quote** and **mention** as two switches: you can answer a line without
pinging. In a room where `@Agent` is how you talk to a named member (and
never implicit “the bot already spoke so it hears everything”), being able to
turn the `@` off without Cancel is the missing control. Cancel today clears
the quote and **keeps** the `@`. There is no “quote only.”

## Research this round

| Source | Lesson |
| --- | --- |
| [Sendbird ThreadMessageInput](https://sendbird.com/docs/chat/uikit/v3/react/features/message-threading/threads) | Placeholder is **Reply in thread** when the parent has no replies, **Reply to thread** once it does. The input copy is the way you know you left the channel composer. |
| [Slack “Use threads”](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions) (still current 2026) | Thread panel has its own field. Mobile even labels it **Add a reply**. Common mistake they document: typing in the channel field when you meant the thread. |
| [Guideflow Slack 2026](https://www.guideflow.com/tutorial/how-to-reply-on-a-message-in-a-channel-in-slack) | After **Reply in thread**, you click the **Reply in thread** text field. The label is the feature. |
| [Stream Chat Thread](https://getstream.io/chat/docs/sdk/react/components/core-components/thread/) | Thread owns **its own composer**. Do not reuse channel composer props unless the UX truly differs — here it does: destination changed. |
| [Baton comment-thread UX](https://batonpass.dev/blog/how-to-design-an-effective-comment-thread-ui-ux) | Reply form says **Replying to [Author Name]**. We already do that on the quote bar; the empty composer still should. |
| [CometChat ThreadedMessages](https://www.cometchat.com/docs/ui-kit/ios/guide-threaded-messages) | Composer placeholder is a documented customization point of the thread screen, not of the channel. |
| [Raft threads 2026-09-08](https://docs.raft.build/features/messaging/threads/) | No nested threads. Follow-ups belong in the thread. Agents live there so the channel stays clean — the composer has to *feel* like it is in that side talk. |
| [Stoat Reply](https://github.com/MCausc78/stoat.py/blob/master/stoat/message.py) | `Reply.mention` is a boolean, default **false** in the Python client. Quote and ping are separate. |
| [Discord `allowed_mentions.replied_user`](https://discord.com/developers/docs/resources/message) | API default is **false**. The client UI still offers an Also-@ toggle per reply. Users have begged for “off by default” because reply is used as *context*, not as a ping ([community post 22342590535063](https://support.discord.com/hc/en-us/community/posts/22342590535063-Setting-to-turn-off-mention-by-default-when-replying)). |
| Discordo / Vencord NoReplyMention | Dedicated **toggle reply mention** keybind. Power users treat quote vs ping as a first-class switch. |
| Hermes Discord `DISCORD_ALLOW_MENTION_REPLIED_USER` | Bots ping the replied-to user only when that flag is on. We will not change agent listen rules. |
| OpenClaw Slack DM-thread bleed (2026-08) / moltbot #758 | Implicit “this thread is the agent’s session” mixes contexts. **Do not** auto-run anyone because you opened a thread or turned Also-@ on. Addressing is identity only. |
| Slack `reply_broadcast` / “Also send to #channel” | Gated. We are not copying channel-broadcast in this slice. Thread replies stay in the thread. |

## Product decision

One helper for the empty-composer sentence. One helper to take `@Name` back
out. Reply still **defaults to addressing** (that is the THREAD-REPLY
decision — this is a room of people *and* agents, and `@` is how you talk to
them). The new control is opt-out, not a change of default.

1. **Room composer** (not in a work-request mode):  
   `Write to the room… @ to address someone`  
   Restore the chat-first copy. Stop overwriting it with `Message…`.
2. **Thread composer** (same, once `currentThreadId` is set):  
   `Reply in this thread… @ to address someone`  
   Screen-reader label already says “Reply in this thread”; keep that.
3. **Work-request modes win** over (1) and (2):  
   request → `What do you need?` · cancelled → `Reason…` · other work → `Your reply…`
4. **Also @** on the quote bar, only when Reply addressed someone:  
   - Pressed (default after Reply): body contains `@Name`, Talking-to is them.  
   - Unpressed: strip that `@Name`, clear Talking-to if it was them, **keep the quote and the thread**.  
   - Press again: same as today’s Reply address (`addressMember` / Talking-to).  
   - Hidden when you reply to yourself or to a revoked member (no author to address).
5. Cancel reply still only clears the quote. Esc still peels quote before
   leaving the thread. Draft text other than the `@` stays.
6. Do not run a model. Do not grant access. Do not auto-open Catch-up / Add
   agent. Do not mark read. Do not broadcast the reply to the room timeline.

Sendbird’s “Reply in” vs “Reply to” (first reply vs later) is more copy than
we need. One thread sentence is enough.

## Checklist — this change

- [x] Pure `composerPlaceholder({ workKind, inThread })` returns the five
      strings above. Unit tests cover room, thread, and each work kind.
      Work kind wins over `inThread`.
- [x] Pure `removeMention(text, member)` deletes one `@Name` token with the
      same word-boundary rule as `messageMentionsMember` (do not eat
      `@Mayafoo`). Surrounding extra space is cleaned so `Ask @Maya tomorrow`
      becomes `Ask tomorrow`. Missing/empty member is a no-op.
- [x] `syncRequestComposer` uses the helper instead of the `"Message…"`
      ternary.
- [x] Quote bar grows `#reply-mention` (`Also @ Name`, `aria-pressed`). Click
      toggles address on/off without clearing `replyToId`.
- [x] Tests: placeholder matrix; removeMention boundaries; roster forbids
      leftover `"Message…"`. HOW-TO-TEST: open a thread, read the placeholder;
      Reply, then Also-@ off.
- [x] Playwright composer check: after opening a thread, placeholder matches
      `/Reply in this thread/`; after Back, `/Write to the room/`.

## Gated

Also-send-to-room (`reply_broadcast`), mention-off-by-default, persist the
Also-@ choice across messages, auto-run on thread follow-up, mailbox, Desk,
DO reset, overlay door, slash-command palette, edit-last on Up.

## How to test

1. Hard-refresh. Empty composer says **Write to the room… @ to address someone**.
2. Open a thread (or Reply). Empty composer says **Reply in this thread… @ to address someone**.
3. Reply to someone else: quote bar, `@Name`, Talking-to, **Also @ Name** pressed.
4. Click **Also @ Name**. Quote stays. `@` and Talking-to go away. Placeholder
   still the thread sentence. Catch-up stays closed. No model starts.
5. Click **Also @ Name** again: `@` returns. Esc still cancels the quote first.
