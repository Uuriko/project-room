# Export, retention, and deletion semantics

What a Project Room keeps, what an export contains, and what "delete" means.
This is the owner-facing definition; `tests/room-export.test.js` pins the
behaviors marked (pinned).

## What can leave a room

- **Room export (any member).** `GET /api/rooms/<id>/export` streams the full
  event log as JSONL, one `{sequence, event}` per line. It is the complete
  history, not the current view.
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
- Composer drafts live in memory in the open tab only; they are not written to
  the room or the browser profile.
- Presence is ephemeral and is not part of the event log.
- Export files are unencrypted point-in-time copies. Whoever downloads one owns
  its handling; deleting content in the room cannot reach copies already taken.

## Owner checklist

- **Before exporting:** the file contains full history, including deleted and
  edited-away content. Share it on that basis.
- **Before deleting:** deletion hides content from members but does not remove
  it from exports or backups.
- **Before importing:** import replaces the room's history wholesale with the
  file's contents.
