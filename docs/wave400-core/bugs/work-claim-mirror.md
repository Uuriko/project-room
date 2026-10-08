# work-claim-mirror.mjs — suspected bugs (not fixed)

## Suspected bugs

- `server/work-claim-mirror.mjs:96` — events with an unparseable `incoming.at` return `null` *after* store.mjs has already INSERTed the event row: the projection holds the claim event but the board never mirrors it (silent split-brain; board and projection diverge with no error).
- `server/work-claim-mirror.mjs:66` — `claimBoard` returns the existing item without claiming when `item.state !== "unclaimed"`: a `claim.acquired` for an already-claimed/owned-by-other board card is silently accepted on the projection side while the board stays unchanged, and no board event is emitted for it.
- `server/work-claim-mirror.mjs:125` — `boardClaimId(data.supersededByWorkItemId)` with a missing `supersededByWorkItemId` collapses to the literal id `"workitem"`: the supersede link, chain entry, and successor card all point at a generic id that can collide with other malformed events.
- `server/work-claim-mirror.mjs:114-120` — handoff calls `claimBoard` (which can throw `too_many_open_claims` if the actor already holds the max) even though the semantic intent is to hand work *away*: an actor at their claim cap cannot hand off via the mirror, and the throw rolls back the projection event.
- `server/work-claim-mirror.mjs:119` — handoff chain is built with `.slice(-20)`: chains longer than 20 links silently lose history (probably an intentional cap, but it is undocumented).

## What was checked and cleared

- **Write ordering / split-brain on board-write failure**: OK by design — the only caller (`server/store.mjs:4790`) runs the mirror inside the same transaction as the event-log INSERT, and the store.mjs comment (lines 4787-4789) documents that a failed board write rolls the command back. No orphan board rows or orphan events on throw.
- **Release path double-write (lines 105-110)**: the intermediate `registry.set` of the paused state is immediately overwritten by `commit`'s final `unclaimed` persist within the same transaction — no partial state is observable.
- **Renew path (98-101)**: correctly falls back to `claimBoard` when the item is missing, unclaimed, or owned by someone else — no unauthorized renew.
- **Successor idempotency (81-88)**: returns the existing `-next` card without verifying `dependsOn` — noted as a behavior caveat in the module doc, not a correctness bug on its own.
- **Stale comments**: none found; the header comment matches the implementation.
- **Dead code**: none (see deadcode/work-claim-mirror.md).
