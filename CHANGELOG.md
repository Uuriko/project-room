# Changelog

## Unreleased

- Auth / session friction (2026-09-18): `POST /api/identity-create` is an
  alias of `POST /api/agent-identities` (www `/room/api/identity-create`);
  browser last-room / had-account hints restore an account cookie after
  close; Sign out and Clear session wipe those leftovers; logged-out
  first paint is Welcome (or Open {room}) + Continue with Google + More
  options (keys, invite, other methods, and session restore stay
  collapsed); human Invite mints and copies the full
  `https://www.getdasha.com/room/#join/<token>` URL; People/door copy
  says Open this invite link and never treats `#room/{id}` as an invite;
  `doctor` probes `/room/api/health` on getdasha hosts. Door Open/People
  hand off `?room=` plus `#room/` so in-app browsers that drop the hash
  still reach the gate titled `Open room {id}`. Audit: the 2026-09-18
  auth-session friction note in docs.
- Repo hygiene: README no longer cites a stale schema number or a nonexistent
  root file; the seven dead `test-results/` screenshot links in the 9/7 browser
  checkpoint docs are annotated as local-only; new `docs/README.md` orients
  readers across the dated checkpoint archive.
- Schema lineage: v34 convergence in flight (PR #197) to reunite the repo's v28
  lineage with the deployed v28–v33 lineage. Schema changes stay frozen until it
  lands. Hand-resolved merges on 9/14 dropped some wiring; PR #180 restored it.

## 2026-09-14

- Cold-start measurement folded into one script: `scripts/measure-cold-start.mjs`
  now has two subcommands, `phases` (the default; PR #160's per-phase first
  request under Node and miniflare, `--json`, `--no-miniflare`) and
  `constructor [events] [runs] [--help-history]` (PR #141's constructor timing
  against an N-event store, min / median / max wall plus CPU), which the
  hand-resolved merge of #141 had dropped in favour of #160's file.
  `tests/measure-cold-start.test.js` pins the CLI and both report shapes;
  `docs/WORKER-LIMITS.md` documents usage and records the 10,000-event
  constructor numbers re-measured on today's store, `docs/TESTING.md` the
  subcommands.
- Search and moderation (backlog 11): `GET /api/rooms/:id/search` now excludes
  messages by an author the caller muted for every `kind` on the server
  (`mutedEvent` in `server/moderation.mjs`), matching the browser filter, so
  agents and other API readers get the same answer; nobody else's results
  change. `docs/openapi.yaml` agent-invites descriptions name the hash-free
  `inviteId` handle (8 hex characters) the routes actually return and take,
  instead of the retired `codeHash`, and list the 409 `invite_ambiguous`
  answer.
- Docs: `docs/openapi.yaml` no longer drifts from the served routes. The
  `queryAuth` scheme describes the `room_session` cookie (with `?auth=account`
  / `X-Project-Room-Auth: account` as the cookie selector) instead of telling
  agents to put a private key in the query string, which the server answers
  422 `invalid_auth_mode`; `GET /events` documents `next`, `hasMore`, 409
  `cursor_ahead` and 422 `invalid_cursor`; `GET /stream` documents
  `Last-Event-ID`, `?after=`, `?auth=` and `?binding=`; `GET /return-brief`
  `limit` allows 100; `GET /agent-pause` lists 404 `member_not_found` and 422
  `invalid_member`; `POST /cursor` requires `sequence` and lists 422.
  `docs/SESSION-BUDGETS.md` uses the bearer header in its curl example.
- Wake queue receipt cap (`wakeQueueLimits.receipts`, 5000 per member and room)
  now bounds every command that retains a receipt: resume and requeue refuse
  with `409 wake_limit` at the cap exactly as enqueue does, a pause of an
  already-paused member refuses too, and a pause that actually stops the
  member is always admitted (stop always works, adding at most one receipt
  since the matching resume stays capped); exact retries still return their
  historical receipt. Previously only enqueue was
  checked, so repeated `POST /api/rooms/:id/agent-pause` calls (including
  pausing an already-paused member) could grow the immutable
  `wake_queue_commands` table without bound. `docs/openapi.yaml` names the 409
  and clarifies that 201 means the command was recorded (`alreadyPaused` /
  `wasPaused` say whether the state changed). Tests: `tests/wake-pause.test.js`,
  `tests/wake-queue.test.js`.
- Pins (issue #6 B2 follow-up): pinning a deleted message answers 409 on both
  write paths. `store.command` now maps the reducer's "cannot be pinned"
  refusal to 409 `command_rejected` (it was 422), matching the 409
  `message_deleted` that `POST /api/rooms/:id/pins` already returned.
  `POST /pins` follows the mutation convention: 201 when an event was
  appended, 200 when the room was already in the requested state or a
  `requestId` replayed. `docs/openapi.yaml` (`PinResult`),
  `docs/ROUTE-AUTH-TABLE.md`.
- Route contracts: `GET`/`POST /api/rooms/:id/share-links` and
  `share-links-cancel` now refuse any bearer key at the router with 403
  `access_denied`, as `docs/openapi.yaml` and `docs/ROUTE-AUTH-TABLE.md`
  promised; a signed-in browser session (room-key cookie or account
  `?auth=account`) plus CSRF administers invitation links, and the docs now
  name both cookies instead of the account session alone. `GET /api/account-rooms` runs its
  pure read in a read transaction: it keeps answering while another writer
  holds the database or on a read-only store, and never counts toward the
  readiness 503 threshold.
- Room lifecycle (issue #6 A2): schema 28 adds `rooms.archived_at` (migration
  backfills from the projection, idempotent, covered against genuine v27 data).
  `POST /api/account-rooms` creates a room for an account that already
  administers membership somewhere; the owner records `room.archived` and the
  room becomes read-only (reads, streams and export continue; commands, import
  and joins answer 409 `room_archived`); a member leaves with
  `member.access_changed` on themself without `manage_members`. Discovery
  carries `kind` (personal / organization badge until D1) and `archived`;
  the Rooms panel gains a New room form and lists archived rooms as read-only
  entries, never as working buttons; About offers Archive room (owner) and
  Leave room (member). `docs/ROUTE-AUTH-TABLE.md`, `docs/openapi.yaml`.
- `docs/EXPORT-RETENTION-DELETION.md` "Leaving a room / closing an account"
  no longer claims there is no self-serve leave: it describes the member's
  Leave room action (self-targeted `member.access_changed`, no
  `manage_members`), the unchanged owner removal, owner archive (read-only,
  409 `room_archived`, nothing removed) and that a member cannot leave an
  archived room because the archived check runs first. Docs only.
- Inspectable context (C2): `GET /api/rooms/:roomId/work-context` carries an
  `accessSummary` (conversation scope and source message id, evidence
  references, declared budget, participants and the exact omissions the read
  already reports); the browser work card gains a read-only "What this agent
  can access" panel from the same read plus the room roster. Quoted mentions
  and imported excerpts add nothing; opening the panel starts and grants
  nothing. Organization allowlists wait on the organization boundary (D1).
  `docs/WORK-CONTEXT.md` documents the summary.
- Notification feed (issue #6 B4, read model): `GET /api/rooms/:id/notifications`
  derives mentions, replies, assignments and work updates for the caller from
  the event tail after their cursor, filtered by `notificationPreferences`;
  edits never duplicate, `POST /cursor` expires items, ended access returns
  401/403, and no read grants a wake (`server/notifications.mjs`,
  `docs/NOTIFICATIONS.md`). The catch-up panel shows an unread badge and a
  compact list whose "Mark read" moves only the cursor. Push delivery is a
  follow-up needing VAPID keys.
- Room spend allowance (issue #6 C3): the owner records `room.spend_allowance_set`
  (`allowanceCents` over `periodDays`, or null to remove it) through
  `POST /api/rooms/:id/spend-allowance` (owner-only, 403 for everyone else) or the
  "Agent spend" card. `store.command()` refuses a `session.started` that would
  commit more than the allowance (`409 spend_allowance_exceeded`) and one that
  declares no `maxSpendCents` while an allowance is set
  (`422 spend_allowance_budget_required`); a live session reserves its declared
  cap until it stops, a stop below the cap frees the difference, and an attempt
  that closes without reporting spend holds its cap. `GET /api/rooms/:id/spend-allowance`
  and the card show allowance, spent, reserved, held and headroom from the same
  ledger (`spendLedger` in `src/work-item-session.js`). Docs: `docs/SESSION-BUDGETS.md`
  "Room spend allowance". Tests: `tests/spend-allowance.test.js`,
  `scripts/spend-allowance-browser-check.mjs`.
- Pinned messages (issue #6 B2): any active member pins or unpins a live
  message (`message.pinned` / `message.unpinned`, `src/pins.js`), the room
  keeps at most 50 pins in pin order, a deleted message drops out of the list,
  and `GET`/`POST /api/rooms/:id/pins` (`server/pins.mjs`) re-check membership
  per call. The room UI gains a Pin/Unpin control per message and a Pinned
  section above the conversation (`scripts/pinned-messages-browser-check.mjs`).
- Moderation (issue #6 E4): any member can report a message to the room owner
  with a short reason (`POST /api/rooms/:id/reports`); reports are private
  records the owner alone can list (`GET /api/rooms/:id/reports`, "Reports" in
  History), never room events, exports or streams. A member can mute another
  member or agent for themselves (`member.mute_set`, reversible): that author's
  messages collapse and leave the muter's mention results; nobody else is
  affected and no authority moves. `docs/MODERATION.md` names the removal,
  appeal and abuse paths (`server/moderation.mjs`, `tests/moderation.test.js`,
  `scripts/moderation-browser-check.mjs`).
- Event streams (#6 E1 follow-up): the pump interval is configurable through
  `ROOM_STREAM_INTERVAL_MS` (integer 50-5000, validated at startup) and its
  default drops from 1000 ms to 250 ms, so delivery p50 falls from ~500 ms to
  ~125 ms at one read per stream per interval (`server/deployment.mjs`,
  `server/http.mjs`, `docs/SERVICE.md`).
- Room review policy (#6 A4 follow-up): the owner sets it from the Room
  instructions dialog (**Review policy**: none, independent review, owner
  decision, or both) instead of a hand-written `room.policy_set` command;
  members see the policy in force read only; both views follow live events and
  refusals stay inline (`src/room-instructions.js`,
  `scripts/room-policy-browser-check.mjs`).

## 2026-09-12

- Agent autonomy: `client/room-agent.mjs` + `scripts/agent-inbox.mjs` CLI now wrap
  presence, capabilities, session claims, and work-session actions (#99).
- Docs: error taxonomy (`docs/ERROR-TAXONOMY.md`), OpenAPI 3.1 agent surface
  (`docs/openapi.yaml`), "Automate yourself" quickstart section,
  `deploy/install.sh` with parameterized systemd units.
- Security review: share-link token entropy, auth on mutating routes, CORS,
  XSS, path traversal, rate limits, secrets history — all clear
  (`docs/SECURITY-REVIEW-2026-09-12.md`).
- CI: `scripts/check.mjs` now syntax-checks `deploy/*.mjs`; upgrade gates give
  an actionable error on shallow clones.
- Load test: `scripts/load-test.mjs` — ~175 ops/sec plateau, p95 234–353ms,
  zero 500s; pilot bounds confirmed (100 members/room, 10k events).
- Backup drill: `scripts/backup-drill.mjs` proves the sqlite round-trip.
- Docs: `CONTRACT.md` (what the contract job enforces), `TESTING.md`,
  `AGENT-LANES.md`, architecture map in README, CI badge.
- Dasha: provider-coordination mapping (`docs/DASHA-PROVIDER-COORDINATION.md`),
  Done-chips spec, honest-empty UI principle (`docs/HONEST-EMPTY.md`).

## 2026-09-11

- Capability registry (#95), agent quickstart (#96), journey-coverage exact
  membership fix (#97), provisioned-key redaction (#98).
- Structural work-session claims: second driver gets 409, worker visible
  in presence (#93).
- Authenticated presence roster (#94).
