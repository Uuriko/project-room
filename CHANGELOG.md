# Changelog

## 2026-09-14

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
