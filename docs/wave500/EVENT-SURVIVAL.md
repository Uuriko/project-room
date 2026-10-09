# Event Survival at Swarm Scale — WAVE-500 Lane Synthesis

**Branch:** `wave500/event-survival` · **Status:** designs + pure-function prototypes, staged for review, nothing merged
**Ground truth (verified at `server/store.mjs:427` on this branch):**
`PILOT_LIMITS = { eventsPerRoom: 1_000_000, membersPerRoom: 100, workItemsPerRoom: 500, projectionBytes: 4 MiB }`

> The projection cap bounced 4→16→6→4→64→4 through the G11 saga (Oct 6–8).
> 4 MiB is current. Every number below uses 4 MiB.

## The reframing: it's not (only) the event log

The lane was briefed as "the 10k event ceiling kills the room at swarm scale."
Measurement says the picture splits three ways:

| Constraint | Binds for | Evidence |
|---|---|---|
| **1M event budget** | claim churn | 5.00 events/lifecycle measured (`tests/swarm-event-burn.test.js`) → ~200k lifecycles/room; claim events consume **0 projection bytes** (claims live in `work_claims`, not the projection) |
| **4 MiB projection** | chat volume | `message.posted` (10 KB body) = 10,398 B/op (`tests/projection-cost-measurement.test.js`); 500 agents × one 10 KB post/day overflows the projection alone; G11 measured muse-room at 82% of projection with the event cap ~10 days out |
| **100 member cap** | agent count | binds *before either* at 500-agent scale (adversarial review) — out of this lane's scope, flagged for the platform lane |

The honest name for this lane is **projection-and-membership survival**; the event
budget is the easiest of the three (4× honest-demand headroom at 1M).

## What we built (17 workers, 17 commits)

**Measurement (ground truth, all green):**
- `tests/event-cost-measurement.test.js` + `docs/wave500/EVENT-COST-TABLE.md` — 7 events per default claim lifecycle (~143k lifecycles/room); 1 per message post/edit; 0 for clean sweep. `?fast=1` is not on this branch (lives on `wave300/data-plane-fastpath`, unmerged) — the harness auto-skips the fast assertion rather than faking it.
- `tests/projection-cost-measurement.test.js` + `docs/wave500/PROJECTION-COST-TABLE.md` — 19 operation types measured; #1 hog is `message.posted`.
- `tests/swarm-event-burn.test.js` — 500-virtual-agent churn: 5.00 events/lifecycle, 0 projection growth, fast path 0 events.

**Designs (docs only):**
- `EVENT-BUDGET-DESIGN.md` — three tiers (room / namespace / lane-velocity), hybrid static floors + borrow pool, honest 409/429 semantics, `?fast=1` consumes zero budget (argued).
- `COMPACTION-DESIGN.md` — A/B/C taxonomy, 70% watermarks, summaries-as-events, sequences append-only (never renumber), cursor-survival contract.
- `ROOM-ROTATION-DESIGN.md` — 75/85/95/100% watermarks, idempotent claim→freeze→snapshot→successor→archive procedure, reuses existing `room.archived`.
- `BODIES-OUT-OF-PROJECTION.md` — **found already shipped** (Phase 1a, `server/projection-at-rest.mjs`, commit `382dbb28f`); doc is gap analysis: `_restoreBodiesFromLog` replays the whole log on read, restores in-memory only (never heals), 500s `projection_corrupt` when replay fails. Three fix options specified.
- `NECESSARY-EVENTS.md` — claim events are pure notifications (safe for `?fast=1`); message events are state-carrying; one verified dead consumer (`updates.mjs` attention matcher); top-5 reductions beyond `?fast=1`.
- `SSE-SURVIVAL.md` — terminal `room_budget_exhausted` frame + clean close at 100%, in-band notice at 90%, no silent throttling.
- `SHARD-BUDGET-NOTES.md` — budget dimension = shard namespace (yes); **gap found:** `workClaimEventData` drops the namespace from the emitted payload (filed as ASK).
- `TELEMETRY-EXTENSION.md` — 3 new gauges (`namespace-budget-low`, `compaction-ineffective`, `rotation-watermark-high`) specced for the telemetry-prod lane.
- `EXISTING-WORK-NOTES.md` — survey of all related wave work and where each stops.
- `ADVERSARIAL-REVIEW.md` — deliberately one-sided attack; ranks lane-velocity 429 throttles highest-leverage, compaction most dangerous, and lists 8 prototype gaps (restart amnesia, multi-instance races, the `?fast=1` bypass, …).

**Prototypes (pure functions, NOT wired into any write path — integration is a later lane):**
- `server/event-budget.mjs` — weighted allocation, borrow-only-from-pool, honest refusal shapes (6/6 tests).
- `server/event-compaction.mjs` — classify/compactRun/translateCursor; 100-event churn → 19 rows (10/10 tests).
- `server/event-coalesce.mjs` — consecutive-update merging + heartbeat suppression (4/4 tests).
- `server/event-cursors.mjs` — epoch cursors `"123"` / `"e2:45"`, legacy-compatible, fail-closed (6/6 tests).
- `server/event-survival-metrics.mjs` — namespaceUsage / compactionStats / rotationWatermark (15/15 tests).

**Test totals:** 69 pass, 0 fail, 1 intentional skip (`?fast=1` assertion, pending the wave300 merge).

## Gaps found (filed, not fixed — first-claim-wins for fix lanes)

1. `workClaimEventData` drops namespace from emitted event payloads (`server/work-claim-events.mjs:28-51`) — breaks per-namespace budget attribution on the wire.
2. Dead consumer: `server/updates.mjs:88-107` matches attention values no emitter produces; the last-200 scan matches zero rows every call.
3. `_restoreBodiesFromLog` (`server/store.mjs:2691`) — full-log replay on read, in-memory-only restore, 500s on failure. Three fix options in the W6 doc.
4. Chat has no budget check at all today (only board writes are gated).
5. Member cap 100 < 500 agents — binds first; needs the platform lane.

## Recommended build order (leverage-per-complexity, per the adversarial review)

1. **Lane velocity throttles (429 token buckets)** — the only realistic event-budget killer is a runaway loop; cheapest effective defense.
2. **Bodies-at-rest gap fixes** (heal-on-restore or checkpoint-on-restore) — attacks the actual binding constraint (projection).
3. **Per-namespace budgets** (W7 design + W8 prototype) — isolation so one swarm can't starve the room.
4. **Rotation** (W11) — the graceful-death story; needs the member-cap answer first.
5. **Compaction** (W4/W5) — most dangerous (irreversible); do last, if at all.

## What this lane deliberately did NOT do

No write-path wiring (all prototypes are pure), no ceiling changes, no merges to
main, no room posts per worker (one lane, minimal noise). Branch `wave500/event-survival`
is staged on origin for the integrator flow: rebase → CI green at exact head → one-at-a-time.
