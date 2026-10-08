# server/work-claim-mirror.mjs (137 lines)

## Purpose
Projection claim commands (claim.acquired, claim.renewed, claim.released, work.handoff_recorded, work.superseded — issued by MCP tools and the work-item form) write the same in-memory work-claims board that the REST /work-claims routes use. This module translates those projection events into board operations so both surfaces see one consistent claim state. A handoff or supersede also leaves a successor card with `dependsOn: [sourceId]` so the chain is visible on the board.

## Public API

- `boardClaimId(workItemId)` — normalizes a work-item id into a board-safe id (regex `BOARD_ID` or cleaned/fallback `"workitem"`). Exported for tests; internal use.
- `mirrorProjectionClaim(store, roomId, actorId, incoming)` — mirrors one projection event onto `store.workClaims`. Returns the resulting board item, the unchanged item, or `null` when there is nothing to mirror. Throws 409 `work_board_full` / `too_many_open_claims` when limits are hit.

Internal helpers: `filesFrom` (paths + labeled blocks → files list), `roomLike` (room config adapter for `claimWork`/`renewWork`), `commit` (board set + `emitWorkClaimEvent`), `claimBoard` (find-or-create + claim), `successor` (find-or-create successor card).

## What it mirrors and where
- Source of truth for the projection: the room event log / SQLite projection in `server/store.mjs` (`this.db` events table).
- Mirror target: the in-memory registry at `store.workClaims` (created by `server/work-claim-sqlite.mjs`), read directly by the REST work-claims board.
- Board items are built with `createWork` / `claimWork` / `renewWork` / `updateWork` from `server/work-claims.mjs`; every mutation also emits a board event via `emitWorkClaimEvent` from `server/work-claim-events.mjs`.

## Sync direction and triggers
One direction only: **projection → board**. Triggered in exactly one place — `server/store.mjs:4790`, inside the command-apply transaction, right after the event row is INSERTed and before the room row is updated. Only the five event types listed above invoke it. It is synchronous and transactional: the store.mjs comment states a failed board write rolls the whole command back. There is no board → projection sync; REST board edits never flow back into the projection.

## Invariants
- Board claim ids are deterministic: `boardClaimId(workItemId)`, handoff successors are `boardClaimId("<workItemId>-next")`.
- Max-open-claims (`config.maxOpenClaims` per room) and per-member active-claim (`config.maxMemberOpenClaims`) limits are enforced on the mirror path, same as REST.
- `claimBoard` only claims items in `unclaimed` state; renew only touches the current owner's item; release steps `in_progress`/`blocked` down through `claimed` before `unclaimed`.
- Chain history is capped: handoff/supersede links append to `chain` and keep only the last 20.

## Top callers
1. `server/store.mjs:4790` — the only production caller (command-apply transaction).
2. `tests/claim-scopes.test.js` — imports `boardClaimId` for handoff-chain assertions.
3. `scripts/runtime-package.mjs:197` — registers the file in the runtime allowlist (browser gate).

## Gotchas
- The mirror runs inside the same transaction as the event-log persist; its 409 throws roll back the *projection event too* — a board limit blocks the whole claim command, not just the mirror.
- `commit()` emits board events (`claimed`, `renewed`, `released`, `state_changed`, `created`) — board event consumers see mirror writes indistinguishably from REST writes.
- Timestamps come from `incoming.at` (client-supplied event time), not server time.
- A handoff's `claimBoard` call can throw `too_many_open_claims` even though the semantic intent is to hand *off* (release) work — the per-member limit is checked before the successor card exists.
- `successor()` is idempotent: if the `-next` card already exists it returns it without touching its `dependsOn` chain.

## Stale comments
- None found. The header comment accurately describes the file: projection claim commands share the board with the REST routes, and handoff/supersede leave successor cards depending on the source (see `successor`: `dependsOn: [sourceId]`, line 82).
