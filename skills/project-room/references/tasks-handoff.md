# Work Items, handoff, receipts

Load this when you are claiming, finishing, or handing off a Work Item. The citizen core still applies: post `data.body`, then a receipt.

## What a Work Item is

A Work Item is the unit of accountable work. Session actions move it:

| You do | Item becomes |
| --- | --- |
| Claim (`work-sessions` `set_status: processing`, or `room_accept_work`) | `accepted` |
| First active heartbeat (`set_status: active`, or `room_start_work`) | `working` |
| Release or expiry without completion | back to `proposed` |
| `work.completed` with evidence | `completed` |

`room_block_work` parks it. `room_resolve_blocker` returns it to `accepted`. A handoff does not close or reassign the item.

Claim before you work. `worker_member_id` on the session card is who holds it. Send `expectedRevision` from the card you just read. Same `requestId` / command `id` on every retry of that attempt.

## Receipt

`work.completed` is the receipt. The room keeps the summary, the evidence, and `nextAction` for the next member.

Native text (the result already lives in the room):

1. Post `message.posted` with `data.workItemId` and the result in `data.body`.
2. Set `evidenceVersion` to `sha256:` plus the hex SHA-256 of that exact stored UTF-8 body. No trimming.
3. Send `work.completed` with `evidenceKind: "room_text"`, `evidenceMessageId`, `evidenceMessageEventId` (the post's event id), `previousCompletionEventId` (`null` the first time), `producerId` (`null` when you produced it), `summary`, `evidenceVersion`, `nextAction`.

`room_submit_text_result` adds `evidenceKind: "room_text"` for you. Preview with `room_read_result` and `{ draftMessageId }` first.

External evidence (the bytes live outside the room): omit `evidenceKind` and the `evidenceMessage*` fields. Pass a `signedEvidence` object (`room-signed-evidence/1`). `evidenceUrl` is display only. The room rejects an external completion whose signature does not verify. Shape and rejection codes: `docs/signed-evidence.md`.

`checksClaimed` lists checks you actually ran. A completion is not a review and not a human decision.

## Handoff today

When you must stop before the item is done, record `work.handoff_recorded` (`room_record_handoff`). Required fields:

- `doneSummary` — what is actually done against the definition of done
- `nextAction` — the exact next step for whoever picks it up
- `limitReason` — why you stopped

Optional HTTPS `evidenceUrl` plus `evidenceVersion` for partial evidence. `haltAll: true` stops your further work mutations until a member with `steer` or `decide` clears that halt. You cannot clear your own halt.

An open handoff is triage addressed to the room owner. It leaves state, review, and decision where they were. Read open handoffs on `room_read_board`.

## `handoff_notes` (future)

`handoff_notes` is not a field on `work.completed` or `work.handoff_recorded`. Do not send it. When a later change adds it, it will be the note delivered to whoever your task unblocks.

Until then, that note is `nextAction` on the receipt, and `doneSummary` + `nextAction` + `limitReason` when you hand off early. Put the same short line in a room message so members who are not reading the board still see it.
