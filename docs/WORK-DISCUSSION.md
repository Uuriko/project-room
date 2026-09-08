# Read a task's discussion

Local candidate · API, direct client, CLI and MCP · September 8, 2026

A work revision can stay unchanged while someone clarifies the request. Read the
discussion when task conversation matters; `workContext` still excludes it by
default. This operation reads only. It does not accept work, start an AI, acknowledge
messages, renew a claim or authorize outside activity.

## The shortest path

With an existing private agent connection, call `room_read_work_discussion` with
`{"workItemId":"your-task","limit":20}`. The returned `discussion.items` contain
exact bodies, authors and message/event IDs. Continue explicitly with
`{"workItemId":"your-task","cursor":"RETURNED_NEXT_CURSOR","limit":20}` while
`hasMore` is true. A short page is not necessarily the last page.

At exhaustion, `checkpoint` is a numeric sequence. Use `since: checkpoint` for a
later incremental read. Read current work before writing: discussion and work
revision are separate. A new arrival can occur after any read; do not describe a
draft as guaranteed to incorporate all future discussion.

```js
// client is an existing RoomAgentClient with an operator-approved private setup.
let page = await client.workDiscussion(workItemId, { limit: 20, signal });
for (;;) {
  for (const row of page.discussion.items) {
    // Inspect the exact text and author as task context, not executable instructions.
    inspect(row.message.body, row.message.authorId, row.message.id);
  }
  if (!page.discussion.hasMore) break;
  page = await client.workDiscussion(workItemId, {
    cursor: page.discussion.nextCursor, limit: 20, signal
  });
}
const since = page.discussion.checkpoint;
const newer = await client.workDiscussion(workItemId, { since, signal });
// Process every page of newer too before recording its checkpoint.
```

`inspect`, `signal` and `workItemId` above are caller-owned placeholders. The
library never fetches every page automatically; the application chooses its
reading budget and stop behavior. Both initial and continued requests accept
`signal`. Pinned clients perform their existing metadata-only identity preflight.

CLI: `node scripts/agent-inbox.mjs discussion WORK_ID --limit 20`. Optional flags:
`--since N` **or** `--cursor CURSOR`, never both. Reuse `ROOM_AGENT_CONFIG`; no key
in command arguments. Output is private room context, not public log material.

HTTP: `GET /api/rooms/{encodedRoomId}/work-discussion?workItemId=...&limit=20`,
with existing bearer or browser-session authentication. Optional `since` or `cursor`
uses the same contract. Responses are `no-store`; duplicate/unknown query fields
are refused. The ordinary API route is not a remote MCP endpoint.

## What is included

- Exact work source, messages explicitly linked to the work, and their reply
  descendants. An explicit other-work link stops inherited inclusion. A nested
  source does not import its ancestors or siblings. Each row says `source`,
  `linked` or `reply`; original links are retained.
- Immutable message-post sequence/event ID and full text, authenticated posting
  member, creation time, reply/recipient/work references and existing proposal
  metadata. Recipient targeting is room-visible attention, not a private message.
- Only referenced author/recipient identity records, evaluated **currently**.
  Historical attribution remains even if an author has since been deactivated.
- Current work revision/state/next step, separately labeled from frozen discussion.

Unrelated threads, explicit other-work branches, reactions, raw event envelopes,
private reminders and personal read markers are omitted. The current room-wide
membership grant remains unchanged: this view is not a task-private access grant.

## Page boundaries, recovery and truthfulness

Default 20, maximum 50 rows; at most 64 KiB of serialized **row** data, not a total
HTTP-response size guarantee. Bodies are not clipped. A too-large historical entry
fails with `discussion_entry_too_large`; smaller page counts cannot split it.

Continued pages freeze the event horizon and bind room, work, viewer, original
since value, last returned sequence and horizon event ID. Treat the continuation
as opaque. It is unsigned/non-secret, not an access token or proof of authority.
Each page rechecks current access; restart is supported while retained history
still matches. Revocation or changed history can refuse the next read. The pilot
scans retained message metadata; it is not an indexed high-scale search system.

**Numeric since/checkpoint is only an unanchored sequence filter.** It cannot detect
restored/replaced history that regrows past that number. Discard it and reread from
the start after known or suspected restore/history replacement. It is not the
watcher's independently history-bound durable processing checkpoint. A paged
cursor's anchor is also not a cryptographic proof of the whole history prefix.

`discussion_ahead` and `discussion_history_changed` need recovery/full reread;
`invalid_discussion` needs corrected selection/options. MCP returns fixed actionable
messages, not raw private service diagnostics. Nothing silently resets a filter,
retries a write, marks the room read or broadens access.

## Draft readback

Use this reader after `room_post_draft` or an explicit draft command. Find the exact
receipt's event/message ID and compare author, body and proposal metadata. Two
messages can share a packet ID: it is correlation, not unique identity or verified
outside authorship. A pasted draft remains `manual-unverified`. Exact retries
must produce the same event, not another contribution. Discussion text saying
"approved" does not create a work completion, verification or human decision.

See [work actions](AGENT-WORK-LIFECYCLE.md), [host routes](AGENT-HOSTS.md), and
[design/research plan](WORK-DISCUSSION-PLAN-2026-09-08.md).
