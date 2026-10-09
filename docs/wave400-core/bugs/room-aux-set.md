# Suspected bugs — room-aux-set (WAVE-400 code archaeology)

NOT fixed — findings only. Scope: `server/room-activation-pack.mjs`,
`server/room-assistant.mjs`, `server/room-key-presence.mjs`,
`server/room-flood-guard.mjs` at `wave400/docs-core` (origin/main `c5d1c313a`).
Each item is `file:line — one-line reason`. Lines are approximate (counting
from the top of each file as read).

## Suspected

- `server/room-key-presence.mjs:54` — `lastSeenAt: hosts[0]?.lastSeenAt` picks an arbitrary host from an unsorted filter, so the reported `lastSeenAt` is not necessarily the most recent.
- `server/room-assistant.mjs:206` — the idempotency `INSERT INTO room_assistant_ops` has no `ON CONFLICT` handling, so two concurrent retries with the same `requestId` could hit a raw `SQLITE_CONSTRAINT` 500 instead of the intended idempotent replay.
- `server/room-activation-pack.mjs:111` — `claimStatusOf` has no NaN guard: a claim with a missing or unparseable `expiresAt` silently reports `"expired"` instead of `"active"`.

## Checked and cleared (no bug found)

- `pinnedOf` dereference safety: `pinnedMessages(state)` (src/events.js:2350) already drops pins whose message is missing/deleted/`body == null`, so `message.authorId`/`message.body` in the pack cannot throw.
- `visible(run.sourceMessageId)` in `RoomAssistant.list` with an undefined id: `messageVisibleToViewer` (server/history-visibility.mjs:78) returns `false` for falsy messages, so no throw.
- Flood-guard ordering: `store.command()` (server/store.mjs:4566–4574) performs the idempotency replay *before* `roomFlood.consume`, so duplicate command ids are free and importEvents/projection replay never consume — matching the module's header comment.
- `createRateLimiter` key `roomId:memberId` with LRU `maxKeys: 2000`: eviction resets a flooded key's budget, which is the documented flood-forgetting tradeoff, not a bug.
- Assistant state machine: `claim` requires `queued` with no `attemptId`; `report` enforces stop-acknowledgment ordering; `done` requires the reporter's own visible result message and all human inputs marked applied; coordinator changes bump revisions and request pauses — no transition found that violates these invariants.
- `enforceAutonomyTierForAction` runs on coordinator `claim`/`report` but is not reachable for `configure`/`invoke`/human actions — matches the "one publisher reserves the host" comment; not verified whether that asymmetry is intended, flagged for review only.
- All exports have live callers (see deadcode doc); no orphaned code found in these four files.

## Notes for a fix pass (deliberate review, not verdicts)

- The 120s host-staleness threshold in `RoomAssistant.list` is hardcoded in two places; making it a named constant would prevent drift.
- The flood guard's fail-open on malformed `roomId`/`memberId` (silent return instead of throw) is defensive by design but means a wiring mistake is invisible; consider a debug log.
