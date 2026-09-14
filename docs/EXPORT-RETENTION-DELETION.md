# Export, retention, and deletion semantics

What a Project Room keeps, what an export contains, and what "delete" means.
This is the owner-facing definition; `tests/room-export.test.js` pins the
behaviors marked (pinned).

## What can leave a room

- **Room export (any member).** `GET /api/rooms/<id>/export` returns the full
  event log as JSONL, one `{sequence, event}` per line. It is the complete
  history, not the current view. The body is assembled in full before the
  response starts and carries a `Content-Length`, so a failure while reading
  history is a JSON error response rather than a truncated file that looks
  like a shorter export, and a dropped connection shows up as an incomplete
  download (pinned). Because the whole file is held in process memory until
  the response starts, one export costs at most the room log cap (10,000
  events) in memory per request; it is throttled by the per-credential read
  rate limit, not by a separate export limit.
- **Readable room export (any member).** `GET /api/rooms/<id>/export?format=html`
  renders the same event walk as one self-contained HTML page for people:
  members, messages, work items and their evidence links. Every value from the
  room is HTML-escaped; the page carries no script and its
  `Content-Security-Policy` (also embedded as a `<meta>` so a saved copy keeps
  it) allows nothing but its own fixed style block. Evidence URLs become links
  only when they are credential-free `https:` URLs; anything else is shown as
  text. Deleted messages appear as "Message deleted" with no body and no edit
  history, so this format shows the room as members saw it, while the JSONL
  format above remains the complete history. It shares the JSONL route's
  authentication, `Content-Length` framing, memory bound and closing
  "End of export" marker (pinned).
- **Room import (owner only).** `POST /api/rooms/<id>/import` replaces the
  room's history with an export file (8 MB cap; larger restores go through
  database backup).
- **Support diagnostics export (owner only).** A sanitized bundle: whitelisted
  scalar fields only — no message bodies, credentials, hashes, or member
  details.
- **Copy and summary actions in the UI** produce ad-hoc text that the person
  copying owns.

## What deletion means

- Deleting a message hides it from the room. The projection keeps only a
  tombstone (who deleted it and when) and purges the message's edit history
  from the projection (pinned).
- Deletion is a visibility rule, not erasure. The event log keeps the original
  message and every edit, so a room export — taken before or after deletion —
  still contains the earlier content (pinned). An import replays exactly what
  the file holds, including that history.
- Editing keeps prior versions in the room's edit history until the message is
  deleted.
- There is no self-serve room deletion. Removing a room entirely is an
  operator action on the service database and its backups, and exports already
  taken are not recalled.

## Privacy-sensitive derivatives, accounted for

- Search, server-side and client-side, never returns tombstoned messages
  (pinned).
- Catch-up, reply previews, decision sources and linked-work chips render
  "Message deleted" in place of the body.
- Composer drafts persist only in the tab's session storage (12-hour expiry,
  at most 50 drafts); they are never written to the room, and closing the tab
  discards them.
- Presence is ephemeral and is not part of the event log.
- Export files are unencrypted point-in-time copies. Whoever downloads one owns
  its handling; deleting content in the room cannot reach copies already taken.

## Leaving a room / closing an account

What the operator and the room owner can do today, as the code stands. There
is no self-serve "leave room" or "close my account" control in the UI or the
API; both are done for the person, and both are visibility and credential
changes, not erasure.

- **Take a copy first.** Any active member can download either export format
  before their access ends; after it ends the export routes answer 403 like
  every other room route (pinned).
- **Leaving a room (owner action).** The room owner, or a member holding
  `manage_members`, ends a membership by posting a `member.access_changed`
  command with `active: false` and the member's current `expectedMemberRevision`
  to `POST /api/rooms/<id>/commands`. In the same transaction the service
  revokes every room credential issued to that member, drops any agent
  connections it held and retires its private reminders
  (`server/store.mjs`, `command`). The member record stays in the room's
  projection marked inactive; the member's messages, work items and evidence
  stay attributed to their display name in the room and in both export
  formats (the readable export marks the member "access ended"). No key can
  be issued to an inactive member. The owner cannot deactivate themselves.
  Reactivation is the same command with `active: true`.
- **Closing an account (operator action).** There is no HTTP route and no
  script for this yet. The operator runs `store.changeAccountAccess(accountId,
  { expectedRevision, active: false, reason })` from a Node process opened on
  the service database (`ROOM_DB`), which in one transaction marks the account
  inactive, advances its revision and authorization epoch, revokes every room
  credential and account credential bound to it, revokes the account's agent
  connections, clears its browser session slots, retires its private reminders
  in every room, and appends a row to `account_access_events` with the reason.
  Every later request authenticating through that account fails closed. The
  same call with `active: true` restores access at the next revision.
- **What closing does not do.** Room memberships stay in each room's
  projection (inactive only if the owner also ended them); messages, work and
  evidence stay in the event log and in exports; private reminders are marked
  resolved rather than deleted, and no other row is removed; backups and
  exports already taken are not recalled. Removing a person's data from the service is a
  separate operator action on the database and its backups, and is not
  scripted.

## Owner checklist

- **Before exporting:** the JSONL file contains full history, including
  deleted and edited-away content; the HTML file shows the room as members saw
  it. Share each on that basis.
- **Before deleting:** deletion hides content from members but does not remove
  it from exports or backups.
- **Before importing:** import replaces the room's history wholesale with the
  file's contents.
