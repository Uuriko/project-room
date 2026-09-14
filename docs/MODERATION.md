# Moderation and abuse handling

Issue #6 E4. What a member can do about a message or a member that should not
be in the room, what the owner can do, and where each path is enforced. Every
path below keeps data inside the room; nothing here contacts an external
service or an automated blocklist (`docs/INVITE-ONLY-CHECKLIST.md` §5 stands).

## Report a message (any member)

- **What**: from a message's actions, **Report** opens a short form (reason,
  at most 280 characters). Sending it records a private report for the room
  owner and confirms "Report sent to the room owner. Only the owner sees it."
- **Who sees it**: the room owner alone, under **History → Reports**, with the
  reporter's name, the reason, the time and the message as it stands now. Any
  other member asking `GET /api/rooms/:id/reports` gets 403 `owner_required`.
  The reporter's own receipt names nobody else. Reports never enter the room
  event log, so `events`, `stream`, the snapshot and the JSONL export carry
  none of them (`tests/moderation.test.js`).
- **What is stored**: message id, reporter id, the message author's id, the
  reason and a timestamp, in the `message_reports` table
  (`server/moderation.mjs`). No message body is copied; the owner reads the
  message from the room, and sees "Message deleted" or "Message no longer in
  this room" when it is gone. Rows are immutable (a database trigger refuses
  updates).
- **Limits**: one report per member per message (a repeat returns the first
  receipt); 20 reports per member per hour (429 `report_limit`); 5000 reports
  per room (409 `pilot_limit`). You cannot report your own message; delete it.
- **Route**: `POST /api/rooms/:id/reports` `{ messageId, reason }` (any active
  member, 201 / 200 duplicate); `GET /api/rooms/:id/reports` (owner only).
  Both are documented in `docs/openapi.yaml` and `docs/ROUTE-AUTH-TABLE.md`.

## Mute a member or agent (for yourself)

- **What**: **Mute** on a message, or "Mute … for me" inside a member's
  capabilities in the People & agents rail, records `member.mute_set` on your
  own member record. That author's messages collapse to "Hidden: you muted …"
  for you alone, their reactions and actions are not shown, they drop out of
  your mention results and new-message announcements, and any notification
  feed derived for you skips their events (`mutedEvent` in
  `server/moderation.mjs` is the hook such feeds call).
- **Who is affected**: only you. The muted member keeps every permission,
  still posts, still sees everything, and is not told. Mute moves no
  `member.revision`, so it never conflicts with invitations or access changes.
- **Reversible**: **Unmute** on any collapsed message or in the rail; the
  messages return immediately. Muting is idempotent.
- **Boundaries**: you cannot mute yourself or the room owner (the owner is the
  appeal path below). A mute is a room event on your member record, visible in
  the shared log like notification preferences; it is a display preference,
  not a block, and it does not hide your messages from the muted member.

## Owner actions (existing)

- **Remove a message**: `message.deleted` tombstones the message for everyone
  (`tests/message-edit-delete.test.js`).
- **Remove a member or agent**: `member.access_changed` with `active: false`
  revokes every credential of that member (`server/store.mjs`); reports about
  their messages stay in the owner's list with the author's id.
- **Isolate a misbehaving agent**: pause its wake queue (W4-48) and end its
  access; the agent's identity link can be removed with
  `DELETE /api/rooms/:id/identity-links`.
- **Invite abuse**: cancel the share link (`POST /api/rooms/:id/share-links-cancel`)
  or revoke the invitation; guest access ends when the link does.

## Appeal

There is no automated decision to appeal. A member who believes a removal,
deletion or report was wrong writes to the room owner (the owner cannot be
muted, so that path is always open). The owner's actions are room events with
actor and time in the shared history; reports are the owner's private record.

## Not in scope here

Spam detection, cross-room blocklists, shared reputation and any escalation
outside the room are not implemented and are not planned for the invite-only
pilot (`docs/INVITE-ONLY-CHECKLIST.md` §5).
