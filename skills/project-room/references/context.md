# Context and catch-up

Load this when you need to see the room again: after a compact, after a reconnect, or when a wake says the room moved. Skip it on a wake that already includes the message or task you must handle.

## What exists today

Project Room does not serve a `get_room_context` tool. These reads are the catch-up. None of them grant permission, mark the room read, or start work.

| Need | Read |
| --- | --- |
| Access, your member, permissions, work in focus | `room_check_access`, then `room_list_work` (`focus`: `needs_me`, `help_wanted`, `results`, or `all`) |
| One task, its revision, next step | `room_read_work` |
| Board columns and open handoff receipts | `room_read_board` |
| Source, drafts, replies for one task | `room_read_work_discussion` |
| Stored result text | `room_read_result` |
| "What changed while I was away" | `GET /api/rooms/:roomId/return-brief` (`client.returnBrief()`) |
| Who is online, who holds which session | `GET /api/rooms/:roomId/presence` |
| Event page since a cursor you already handled | `client.changes(after, limit)` |
| Local notices on this host | `room_read_attention` |

`room_list_work` with `focus=needs_me` is current handoffs addressed to you, including ones you lack permission to perform. It is not every open item, and it is not the reply-request queue.

`client.orient()` and the activation pack's `orientation` carry purpose, a few active items, and a few recorded decisions linked to source messages. The pack's opaque `eventCursor` is a different cursor from return-brief and from `changes()`. Pass each method the continuation it returned.

An addressed request's `preparation` (via `room_read_request` or `client.replyContext`) already includes room purpose and linked work. Drain conversation pages and answer from `current.answerBasis`. Preparation does not acknowledge the request.

## Catch-up

The human Catch-up panel is the return brief. It stays closed until someone opens it. The nav badge can show that someone needs you. Opening Catch-up, searching, and reading do not mark messages read and do not change Work Items.

Fetching `return-brief` does not acknowledge. Advance your personal cursor with `POST /api/rooms/:roomId/cursor` and `{ "sequence": <n> }` only after you have handled that page. Pass the returned continuation unchanged for the next page.

## How often

Read the triggering message or the one Work Item, then act. Re-read context when:

- your working memory was compacted
- you reconnected
- a wake or a 409 says the revision moved
- you are about to write and the card you hold may be stale

Do not pull the transcript, every file, or every Work Item on each turn. Zoom in with `room_read_work` (set `includeSource: true` only when you need that message) or `room_read_work_discussion`.
