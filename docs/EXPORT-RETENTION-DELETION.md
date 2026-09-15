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
  "End of export" marker (pinned). In the room UI, **Export as HTML** in the
  History panel downloads it for the signed-in member (`room-<id>-export.html`).
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
- Redaction (below) is the one way to take the text itself out of the room's
  history; use it when deletion's visibility rule is not enough.
- There is no self-serve room deletion. The owner can archive a room (below),
  which makes it read-only but removes nothing. Removing a room entirely is an
  operator action on the service database and its backups, and exports already
  taken are not recalled.

## Redaction (issue #6 D6)

Redaction removes a message's text from the event log itself, not only from
the view. It is the one deliberate exception to append-only event bodies, and
it is designed so that every path that replays history reproduces the
redaction rather than the text. `tests/message-redaction.test.js` pins the
behaviours marked (pinned).

- **Who.** The room owner or the message's author posts
  `{ type: "message.redacted", data: { messageId } }` to
  `POST /api/rooms/<id>/commands`. Anyone else is refused (pinned). A deleted
  message can still be redacted; that is the intended way to purge text that
  deletion only hid.
- **What changes in the log.** In the same transaction the service appends the
  `message.redacted` event and rewrites the target's `message.posted` and
  every `message.edited` event: `data.body` is removed and
  `data.redacted = { bodySha256, redactionId }` names the SHA-256 (hex) of the
  removed text and the redaction event's id. Event ids, sequences, actors and
  timestamps are unchanged, so the log stays dense and every reference to the
  message (replies, work links, reply requests, decisions) still resolves.
- **What the room keeps.** The projection keeps the message as a tombstone
  with `redactedAt`, `redactedBy` and `bodySha256` (the hash of the last body
  before redaction) and an empty edit history. The room and the readable
  export show "Message redacted". Search, catch-up, reply previews and
  decision sources never see the text again (pinned). A redacted message
  cannot be edited, deleted or pinned; a second redaction appends nothing and
  answers the first (pinned).
- **Export, import, rebuild, restore.** The JSONL export carries the rewritten
  events and the redaction event; importing that file reproduces the
  redaction, and an import whose file still carries the text of a redacted
  message is refused (pinned). A projection rebuild replays the rewritten log.
  A database backup taken after the redaction contains no copy of the text
  (pinned); a backup taken before it still does, and so does any export taken
  before it — redaction reaches the service's own storage, not copies already
  handed out.
- **Verification.** `SHA-256(original text)` equals the recorded
  `bodySha256`, so a person holding a copy can prove what was redacted
  without the service holding it (pinned). A native work result whose
  message was redacted keeps its evidence version for the same reason: the
  hash is the content from then on. On every open (writable and read-only)
  the service checks that no redacted message keeps text in the events, the
  projection or the retained checkpoint and that the `message_redactions`
  table and the log agree, and refuses to serve otherwise (schema 35,
  `server/message-redaction.mjs`).
- **Limits.** Text already delivered to an agent, a channel or a browser is
  not recalled. Work-item titles, descriptions, charters and decisions are not
  messages and have no redaction yet. Removing a whole room or a person's
  every trace remains the operator action described above.

## Retention policy (stub)

There is no automatic retention or expiry today: a room keeps its history
until the owner deletes or redacts messages, or the operator removes the room.
When a policy is introduced it will be recorded per room as an owner decision
(retention period, what expiry does — redact or remove) and applied by the
service as redactions, so that the same replay guarantee above holds. A
preservation hold (a role that suspends expiry and refuses redaction while a
matter is open) needs the organization boundary and roles from D1 and is
deferred to it.

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

What a member, the room owner and the operator can do today, as the code
stands. A member can leave a room themselves and the owner can archive a room;
closing an account is still done for the person by the operator. All of these
are visibility and credential changes, not erasure.

- **Take a copy first.** Any active member can download either export format
  before their access ends; after it ends the export routes answer 403 like
  every other room route (pinned).
- **Leaving a room (member action).** A human member other than the owner
  leaves with **Leave room** under About (`#room-leave-button`, `src/app.js`),
  which posts a `member.access_changed` command on themself to
  `POST /api/rooms/<id>/commands` with `active: false`, their permissions
  unchanged and their current `expectedMemberRevision`. A self-targeted
  command of exactly that shape is a leave request (`isLeaveRequest`,
  `src/events.js`) and needs no `manage_members`; any other change to a
  membership still does. Returning afterwards needs a new invitation, or
  reactivation by someone holding `manage_members` (the same command with
  `active: true`); a member cannot reactivate themselves. The owner cannot
  leave: deactivating the owner is refused, and the button is hidden for them.
- **Ending a membership (owner action).** Unchanged: the room owner, or a
  member holding `manage_members`, posts the same `member.access_changed`
  command with `active: false` for another member.
- **What ending access does, either way.** In the same transaction the
  service revokes every room credential issued to that member, drops any
  agent connections it held and retires its private reminders
  (`server/store.mjs`, `command`). The member record stays in the room's
  projection marked inactive; the member's messages, work items and evidence
  stay attributed to their display name in the room and in both export
  formats (the readable export marks the member "access ended"). No key can
  be issued to an inactive member, and the export routes answer 403 to them
  like every other room route.
- **Archiving a room (owner action).** The owner records `room.archived`
  (**Archive room** under About, or the command with an optional `reason` of
  at most 280 characters). From then on the room is read-only: reading, the
  event stream and both export formats continue for every active member, and
  every command, import, invitation join and agent join into that room
  answers 409 `room_archived`. Nothing is removed and no credential is
  revoked. There is no un-archive event and no self-serve deletion; removing
  an archived room is the operator action described above.
- **Leaving an archived room.** Because the archived check runs before the
  leave check (`refuseArchivedWrite` in `server/store.mjs`, `command`), a
  member cannot leave an archived room: the command answers 409
  `room_archived` and the UI says so ("This room is archived; leaving is not
  recorded"); the Leave room button is hidden once the room is archived.
  Their membership and credentials stay as they were, and the export routes
  keep answering them. Take a copy before the owner archives if you want to
  end your access afterwards; otherwise ending it is an operator action on
  the service database.
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
  projection (inactive only if the person left or the owner ended them);
  messages, work and
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
  it from exports or backups. Redact instead when the text itself must leave
  the service's history; copies already taken are still not recalled.
- **Before importing:** import replaces the room's history wholesale with the
  file's contents.
