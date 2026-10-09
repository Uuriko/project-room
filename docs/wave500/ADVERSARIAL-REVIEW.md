# Adversarial Review of the WAVE-500 Event-Survival Lane

W17/17. Status: review. This document attacks the lane's own designs.
It is deliberately one-sided; the lane's advocates can rebut each point
from the design docs it cites.

## 0. The premises that don't survive contact with the code

Before attacking any design, the framing gets attacked first. Three
ground truths from this branch (`server/store.mjs:427`):

```js
export const PILOT_LIMITS = Object.freeze({
  eventsPerRoom: 1_000_000,
  membersPerRoom: 100,
  workItemsPerRoom: 500,
  projectionBytes: 4 * 1024 * 1024,
});
```

**P1. This is not a 500-agent room.** `membersPerRoom` is 100. The room
409s member #101 (`store.mjs:4651`) — long before any event budget is
interesting. Every design in this lane optimizes survival at a scale the
room cannot physically reach. If the member cap doesn't move, "500-agent
event survival" is fiction; if it does move, none of these designs
account for the member-lifecycle event flood (500 joins × ~3 events +
invites + attention fan-out ≈ 2k events minimum, all concentrated at
room start, all attributed to `default`).

**P2. The event count is not the binding constraint.** The comment above
`PILOT_LIMITS` records the G11 finding (2026-10-06): muse-room — a real,
production room, far below 500 agents — reached **82% of the 4MB
projection with the event cap ~10 days out**. Measured, not modeled: the
projection runs out on the order of **10–15× faster** than the event
budget. A lane named "event-survival" that meters the abundant resource
while the scarce one burns is a lane pointed at the wrong meter.

**P3. The projection cap is not a design variable.** The cap history is
4 → 16 → 6 → 4 → 64 → 4 (the G11 saga, per the branch note and the
parent brief). Any design whose math depends on "4MB (current)" is
anchored on sand — the number has moved six times in days. Designs must
work *under uncertainty about the cap*, not be tuned to its current
value.

**P4. Bodies-out-of-projection already shipped.** `storedProjection` /
`bodyRef` / `projection_bodies` / `_restoreBodiesFromLog` /
`rehydrateAllProjections` are all in `server/store.mjs` on this branch.
The G11 note says it explicitly: "Bodies-at-rest supplies projection
headroom." One of the lane's five design directions is a design doc for
a feature that is already in production.

---

## 1. The strongest argument against each design direction

### 1.1 Compaction (W5; not yet landed — attacked from first principles)

The event log is not a cache. It is the integrity anchor of the entire
system:

- `_restoreBodiesFromLog` (`store.mjs` ~2690) replays the event log as
  **the source of truth** to refill missing bodies, failing closed with
  `fail(500, "projection_corrupt")` when it can't. Compact the log and
  the bodies-at-rest recovery path — the very system the lane leans on
  for projection headroom — 500s.
- Receipts, bounty escrow chains, and integrity snapshots reference
  event ids and sequences. Compaction renumbers history; every external
  reference becomes a dangling pointer. There is no migration for a
  receipt pinned in someone else's database.
- Replay is assumed deterministic from a full log (`_replayRoom`,
  `rebuildProjection`). A compacted log is a *rewrite of history*, not a
  projection of it; any agent holding a cursor, a digest, or a cached
  projection against the old log now disagrees with the server about
  what happened.
- Operationally: compacting a 1M-event SQLite table mid-room is a
  multi-second write lock on the single writer. The "solution" to budget
  exhaustion introduces a latency cliff precisely when the room is
  busiest.
- Philosophically: compaction gives the *illusion* of headroom while
  destroying the only audit trail. It converts a loud failure (409,
  honest) into a quiet one (history silently rewritten). The room's
  rules regime is built on "no fake anything" — a compacted log is a
  curated past.

The strongest single sentence against it: **compaction trades the one
property the event log exists for (an immutable record) for headroom on
a budget that isn't binding.**

### 1.2 Per-namespace budgets (W7 + W8, both landed)

Per §0/P2, this rations the abundant resource. But even taken on its
own terms, the design has a structural flaw its authors name and then
wave away:

- The `?fast=1` exemption (W7 §5, "position: fast writes consume zero
  event budget") is a **designed bypass through the entire budget
  system**. Any lane under budget pressure moves to `?fast=1` and keeps
  writing — burning projection bytes and state caps that the budget
  doesn't meter. The budget is binding exactly on the lanes that don't
  need it and advisory on the ones that do.
- The honest-demand math in W7 §2 is the design's own refutation:
  honest 500-agent demand is ~250k of 1M — **4× headroom**. The budget
  never binds honest use; it binds only runaways. And for runaways, the
  T2 velocity throttle (a token bucket, ~100 lines, precedent at
  `channel-send-budgets.mjs:107-118`) contains the failure mode without
  any of the lifetime-accounting machinery. The whole T0/T1 floor/borrow/
  ceiling apparatus exists to solve a problem the T2 throttle already
  solves.
- Borrowing semantics reintroduce the starvation bug one level down:
  the shared pool is first-come-first-served. The first namespace to
  exhaust its floor drains the pool; later namespaces 409 against a
  "shared" pool that is empty *because* it was shared. The design
  advertises isolation and delivers a race.
- `CODE_UNKNOWN` (W8) is a footgun: one worker's typo'd namespace in a
  500-agent swarm → permanent 409 with no owner-visible signal beyond
  the refused write itself. The failure mode is silent, per-worker, and
  scales with agent count — the exact population this lane serves.
- Owner-operability: floors, ceilings, borrow ratios, lane velocity
  buckets per (namespace, lane) — this is a half-dozen knobs per
  namespace that will ship misconfigured, and misconfiguration fails
  *closed* (409s on honest workers).

The strongest single sentence against it: **it is a sophisticated
metering system for a resource with 4× headroom, with a designed
bypass, that reintroduces starvation inside its own shared pool.**

### 1.3 Bodies-out-of-projection (sibling design; substance already in prod)

Nothing to attack in the mechanism — it's correct, shipped, and the
G11 evidence says it works. The attack is on the lane's treatment of
it:

- Writing a design doc for shipped code is re-litigating, not
  designing. The remaining work is maintenance (readback edge cases,
  the `projection_corrupt` 500 path), not architecture.
- Its one genuine fragility is unaddressed by any lane doc:
  `_restoreBodiesFromLog` is fail-closed — a missing body row 500s
  **every room read** — and the recovery replays the *entire event log*
  on the read path. At 1M events that replay is not a fallback, it's a
  denial of service. The design direction should have been "harden the
  restore path" (bounded replay, degraded-read mode), not "design
  bodies-out-of-projection."

The strongest single sentence against it: **the design work is done;
what remains is the one failure mode nobody is assigned to.**

### 1.4 Room rotation (W11, landed)

Rotation is a room migration wearing archival's clothes, and migrations
are where data goes to die:

- Identity fragmentation: claims are re-created as *new* rows with
  `predecessor_claim_id`; claim ids change across the boundary. Every
  deep link, every receipt, every external reference to a claim id —
  the things agents actually share — breaks or requires a translation
  layer that doesn't exist.
- The 500-agent re-auth storm: credentials don't carry over, so up to
  500 agents rejoin the successor at once. That storm hits
  `membersPerRoom` (100!), the event budget (joins are events), and the
  attention fan-out *in the new room* — rotation front-loads the exact
  pressure it claims to relieve.
- The "zero lost writes" guarantee rests on every client correctly
  handling `room_rotation_freezing` 409s and the terminal SSE frame.
  Agents that don't implement the new protocol lose work *silently* —
  the freeze window converts a loud 409 (today) into a quiet client
  bug. The design optimizes for the clients that read the doc and
  abandons the ones that didn't.
- The freeze carve-outs (`store.mjs:3436`/`3443` owner/system exemptions
  to push rotation events past 100%) are new holes in the bounded-pilot
  guarantee, each one a precedent for the next carve-out.
- It moves the problem, not solves it: the successor is a normal room
  with the same 4MB projection. At 500-agent scale, room chains become
  the norm and history fragments across N archives — the "continued at"
  UX is a graveyard of predecessors.
- Open question #1 in the doc (auto-claim at 95% without an owner
  online vs. parking at 95%) is not an open question, it's the design's
  load-bearing wall: if nobody is online to claim, the room dies
  exactly as it does today, and the whole rotation apparatus is
  theater.

The strongest single sentence against it: **rotation's success path
requires 500 agents to re-authenticate into a room that caps at 100
members, and its failure path is identical to doing nothing.**

### 1.5 Cursor epochs (not yet landed — attacked from first principles)

Cursor epochs are second-order complexity: the problem they solve (SSE
survival across rotation/compaction) exists only because rotation and
compaction created it.

- The existing terminal-frame design (W11 §2: `event: room_rotated`
  then close; client opens the successor at sequence 0) already answers
  "what does a cursor do at the boundary." Epochs add a version vector
  on top of a protocol that already has a terminal signal — two
  mechanisms for one transition, which means two ways to disagree.
- Epoch × archive interaction: an old cursor (room A, seq 950k) against
  a new epoch (room A archived, epoch 2) resolves ambiguously — replay
  from archive? redirect to successor? The design must specify
  resolution for every (cursor, epoch) pair, and each unspecified pair
  is a silent-truncation bug.
- Cheaper answer that already exists: cursors are `(room_id, sequence)`
  pairs; rotation is a room-id change, which the client already handles
  for invites and deep links. No epoch machinery needed — the
  transition is a new room, not a new cursor version.

The strongest single sentence against it: **epochs pay for complexity
only if you first pay for rotation; refuse rotation and epochs
evaporate.**

---

## 2. The "do nothing" alternative — honest math with the 4MB projection

Do the math from first principles. All numbers grounded above.

### 2a. The event count: the stopgap suffices

W7's own honest-demand estimate for a 500-agent room:

| Source | Estimate |
|---|---|
| Claims: 500 agents × 30 lifecycles × 6.5 events | ~97,500 |
| Chat: 500 agents × 200 messages × 1 event | ~100,000 |
| Member lifecycle, work items, system | ~50,000 |
| **Honest total** | **~250,000 of 1,000,000** |

The 1M cap is **~4× honest demand**. Per the W7 doc: "The 1M budget is
~4x honest demand. The binding risk is not rationing honest use — it is
a runaway loop." The honest answer: **for the event count alone, do
nothing — the stopgap has 4× headroom.** Nothing in this lane needs to
ration honest event consumption.

### 2b. The projection: the stopgap does NOT suffice

The G11 measurement (recorded in the `PILOT_LIMITS` comment, 2026-10-06):
muse-room reached **82% of the 4MB projection with the event cap ~10
days out**. At constant burn rates, the projection binds roughly an
order of magnitude before the event count. Bodies-at-rest (shipped) is
the mitigation the room already applied — and the cap has since been
raised and lowered six times (4→16→6→4→64→4), which is what you do to a
number that keeps binding.

So the honest answer is split, and the lane's name is wrong:

- **Events: do nothing. 4× headroom. Suffices.**
- **Projection: do nothing fails.** The projection is the binding
  constraint at any real scale, confirmed by measurement, and it is
  *already* the thing bodies-at-rest was built to relieve.
- **Members: do nothing fails hardest.** 100 < 500. The member cap
  binds before either of the above. This lane doesn't touch it.

### 2c. What "do nothing, honestly" looks like

The minimum viable survival posture, requiring no new design:

1. Keep the 1M event cap (4× honest headroom — no rationing needed).
2. Keep bodies-at-rest (already shipped) and harden its restore path
   (the unbounded-replay 500 — §1.3).
3. Add the T2 lane velocity throttle (429s, token bucket) — the one
   mechanism that addresses the only realistic event-budget killer
   (runaway loops), at ~100 lines with existing precedent.
4. Raise or shard `membersPerRoom` / `workItemsPerRoom`, or admit the
   room is not a 500-agent room.

Items 1–3 are a weekend. The rest of the lane — namespace lifetime
budgets, compaction, rotation, cursor epochs — is optimization and
migration machinery for a constraint that doesn't bind (events) while
the constraints that do bind (projection bytes, member seats) get one
shipped fix and a design doc.

**Verdict: "do nothing" is adequate for the event budget and
inadequate for the room. The lane should be renamed "projection-and-
membership survival" and cut two-thirds of its scope.**

---

## 3. Leverage-per-complexity ranking

Ordered highest to lowest leverage per unit of complexity. "Leverage"
means: reduction in the probability of a real room death, per the
failure modes actually observed (G11) or the lane's own honest math
(W7 §2).

| Rank | Design | Leverage | Complexity | Notes |
|---|---|---|---|---|
| 1 | **Lane velocity throttles (T2)** | High — contains the *only* realistic event-budget killer (runaway loops) | Low — token bucket at existing 429 choke points, precedent in `channel-send-budgets.mjs` | The single change worth building |
| 2 | **Bodies-at-rest hardening** | High — projection is the measured binding constraint | Low — already shipped; harden the restore path | Maintenance, not design |
| 3 | `?fast=1` guidance for chatty lanes | Medium — zero-event path exists today | Zero — docs only | Free headroom, already paid for |
| 4 | Per-namespace lifetime budgets (T1) | Low — meters the abundant resource; has a designed bypass (§1.2) | High — floors/ceilings/borrow/config × namespaces | Sophisticated answer to the wrong question |
| 5 | Room rotation (W11) | Medium — genuine end-of-life path, but its failure path equals doing nothing (§1.4) | Very high — migration, re-auth storm, identity fragmentation | Correct but premature; build after the member cap moves |
| 6 | Cursor epochs | Near-zero standalone — only meaningful under rotation | Medium — version-vector resolution matrix | Second-order complexity (§1.5) |
| 7 | **Compaction** | Negative — destroys the audit/replay properties the room depends on | High — and irreversible | The most dangerous change |

### The single highest-leverage change

**Per-lane velocity throttles (T2): 429 `lane_event_rate_limited` with
`Retry-After`, token bucket per (namespace, lane), at the existing board
and message choke points.** It is the only design whose failure mode
(runaway loop) is the only way the event budget actually dies, per the
lane's own math. Everything else in the lane is either already shipped
(bodies-at-rest, `?fast=1`), meters a non-binding resource (T1), or
migrates the problem (rotation).

### The single most dangerous change

**Compaction.** It is the only design on the list that is *irreversible*
and that destroys a property other systems depend on: the event log as
an immutable, replayable source of truth (`_restoreBodiesFromLog`
fails closed 500 without it; receipts and escrow chains reference its
sequences). Rotation is operationally hairy but additive and resumable;
compaction is a one-way rewrite of history. If the lane builds one
thing it later regrets, it will be this.

---

## 4. Failure scenarios the prototypes do not cover

The prototypes (W8 `server/event-budget.mjs`, W10
`server/event-coalesce.mjs`; W5/W12/W16 not yet landed) are pure
functions. Pure functions assume a single-threaded, crash-free caller
with a monotonic clock. The server is none of those.

1. **Multi-instance race on the budget (W8).** `tryConsume` takes a
   state object and returns a new one. Two server instances both read
   the pool as non-empty, both borrow, both write back — the pool
   overshoots. There is no CAS, no fencing token, no
   compare-and-swap on the counter row. Under the 500-agent load this
   lane is for, multi-instance is the deployment shape, and the first
   namespace to exhaust its floor will be borrowing concurrently with
   three others. The prototype's "borrowing NEVER touches another
   namespace's allocation" holds only in a single process.

2. **Restart amnesia (W8).** Budget state (`used`, `borrowed`,
   `unallocatedPool`) lives in the prototype's memory. A deploy, a
   crash, or a rolling restart resets every counter to zero — every
   namespace silently gets a fresh full budget. Double-spend is not an
   edge case; it is the default behavior on every restart. The design
   doc's "spent-since-enable counters" (W7 §6) names a persistence
   layer the prototype doesn't have.

3. **The `?fast=1` bypass is load-bearing and unmeasured (W7+W8).**
   Fast writes consume zero budget *by design*. A lane under budget
   pressure moves to `?fast=1` — still burning projection bytes (the
   binding constraint) and state caps, unmetered by the budget. The
   prototypes model a world where all consumption flows through
   `tryConsume`; the real world has a documented zero-cost lane around
   it. No prototype covers "budget says 0 remaining, writes continue
   via fast."

4. **Coalescing is memory-only and restart-unsafe (W10).** The live
   coalescing map (`lastClaimEvent` in `work-claim-events.mjs`) is
   per-store memory. A restart replays the full note sequence —
   duplicates the prototype's pure function promised to merge. Worse,
   the prototype's `coalesceUpdateLog` merges on `at` timestamps with
   an `at - firstAt >= 0` guard: clock-skewed or out-of-order arrivals
   silently start new groups, and the merged `notes` array is
   unbounded — a note flood merges into one giant event body that can
   itself trip body/projection limits. The prototype models ordered,
   clock-true input; the wire doesn't provide it.

5. **Heartbeat suppression destroys the liveness signal (W10).**
   `shouldEmitHeartbeat` suppresses keepalives while the last emission
   is fresh. A suppressed heartbeat is indistinguishable from a dead
   lane holding a claim — stale-claim detection (the thing the 60s
   coalescing window in `work-claim-events.mjs:140` exists to serve)
   degrades exactly when it matters: a crashed worker's claim looks
   "quiet" instead of "dead." The prototype optimizes event count and
   spends observability.

6. **Coalescing loses per-update attribution (W10).** Merged entries
   concatenate notes and count updates, but collapse N writes into one
   event. Per-update actor, per-update timestamp ordering across
   actions, and intermediate states become unrecoverable from the log.
   A buggy or malicious lane's intermediate states — the ones an
   audit would need — are gone by design. The prototype has no field
   for "who wrote update #7 of 12."

7. **Borrow-pool first-wins starvation (W8).** The shared unallocated
   pool is drained by whoever exhausts first; the prototype's
   `borrowRatio`-per-call cap slows one caller's drain but doesn't
   stop four namespaces racing. Later namespaces 409 against a pool
   that was "shared" in name only. This is the starvation bug the T1
   tier claims to fix, reproduced one level down inside the fix.

8. **The crash-between-check-and-append gap (W8+W10).** The prototypes
   decide *whether* to emit; the store decides *whether the event
   lands*. Nothing in the prototypes covers: budget check passes →
   process crashes → event never appended → on recovery the write is
   retried against a budget that was already charged (double-charge),
   or the budget was never charged and the event landed anyway
   (free event). Pure functions can't model the two-phase reality of
   check-then-append, and the lane has no idempotency-key story for
   budget consumption.

---

## 5. What the lane should do instead (the adversarial recommendation)

1. **Build T2 velocity throttles and nothing else from the budget
   family.** It is the highest-leverage change (§3) and the only one
   whose failure mode is real.
2. **Harden the bodies-at-rest restore path** (bounded replay,
   degraded-read mode instead of the 500) — the one shipped system
   with an unassigned fragility.
3. **Address `membersPerRoom: 100`** before any more event work. Until
   the member cap moves, this lane is designing for a scale the room
   rejects at the door.
4. **Shelve T1 lifetime budgets, compaction, rotation, and cursor
   epochs.** Revisit rotation only after the member cap moves and the
   projection has a second measured near-death; compaction never —
   some properties (an immutable log) are load-bearing and not for
   sale.

*Filed by W17/17. The lane is stronger if this document is wrong —
rebuttals welcome, with measurements.*
