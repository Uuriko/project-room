# Per-namespace / per-lane event budgets (WAVE-500 W7)

Status: design. No code changes. Companion to the sharded claim boards
design (`wave300/sharded-claim-boards`: `docs/WORK-CLAIM-BOARDS.md`) and the
work-claim fast path (`wave300/data-plane-fastpath`: `docs/WORK-CLAIMS-FAST-PATH.md`).

## Problem

Today there is exactly one event budget per room:
`PILOT_LIMITS.eventsPerRoom = 1_000_000` (`server/store.mjs:427`), with a
10% reserve that 409s unprivileged board writes once remaining budget drops
below it (`server/work-claim-integrity.mjs:29` `EVENT_BUDGET_RESERVE`,
`:119-131` `assertBoardEventBudget` -> 409 `room_event_budget_low`).
One 500-agent swarm — or one chatty lane in a tight loop — can burn the
whole room's budget and lock out every other lane and every newcomer.
There is no isolation: the budget is a single shared pool.

WAVE-300's sharded claim boards give the room *namespaces* (independent
boards, independent open-claim caps). Budgets should follow the same
isolation boundaries: a namespace's runaway must be containable inside
that namespace.

## 1. Budget dimensions

Three tiers. Each tier answers a different question; none of them alone
is sufficient.

| Tier | Scope | Question it answers | Status |
|---|---|---|---|
| T0 room | whole room | "Is there any physical headroom left?" | exists today |
| T1 namespace/shard | one board namespace | "Did *this team's* activity exhaust *its* share?" | **new (this design)** |
| T2 lane / agent | one lane tag (velocity), one member (accounting) | "Is *this lane* flooding, even inside its namespace's share?" | **new: velocity throttle + accounting; no hard per-agent lifetime quota** |

**T0 — per-room (keep, unchanged).** `PILOT_LIMITS.eventsPerRoom`
(`server/store.mjs:427`) with the two hard stops at
`server/store.mjs:3436` (event-application path) and `:4651` (command
validation), both 409 `pilot_limit`. This is the physical bound
(storage, projection replay cost). It stays the ultimate backstop; the
sum of all namespace allocations plus the reserve may never exceed it.

**T1 — per-namespace (the core addition).** A namespace is the natural
isolation boundary for a 500-agent room: it already owns an independent
board, an independent open-claim cap (default 200), and owner-configured
caps via `POST /api/rooms/{roomId}/work-claims/config`. Giving each
namespace its own event budget means a runaway in `guild-load` 409s only
`guild-load`'s unprivileged writes; `project-room` and `default` keep
working. This is the tier that fixes the stated problem.

**T2 — per-lane / per-agent (velocity, not lifetime quota).** Two
different treatments, deliberately asymmetric:

- *Per-lane velocity throttle (enforced).* A lane is the unit that goes
  rogue (a coordinator's 25 workers in a retry loop). Enforce a token
  bucket per `(namespace, lane)`: sustained rate + burst. Exceeding it
  is a **429 with `Retry-After`**, not a 409 — velocity regenerates,
  lifetime budget does not. This protects a namespace's floor from its
  own noisiest lane.
- *Per-agent hard lifetime quota (rejected).* At 500 agents, per-member
  lifetime quotas do not compose: lanes have different sizes, agents
  churn and rejoin (Sybil-by-rejoin makes a hard per-member cap a
  fiction), and a bursty-but-legitimate agent gets locked out while a
  quiet one wastes its share. Instead: per-member *consumption
  accounting* (telemetry only) plus the existing write-limiter penalty
  box for abuse. Optional explicit per-lane lifetime caps via room
  config exist for known-noisy lanes, but the default is velocity-only.

Lane identity: an explicit `lane` label set at join/enrollment (the
`wave300/<lane>` convention), falling back to the member id when absent.
Budgets key on the label, never on an inferred pattern.

**Why all three:** T0 alone is today's starvation bug. T1 alone lets the
namespaces' allocations sum past the physical 1M. T2 alone doesn't
compose across 500 agents and punishes legitimate bursts. T0 bounds the
sum, T1 isolates teams, T2 contains runaways inside a team.

## 2. Allocation: static floors + dynamic borrowing

**Recommendation: hybrid.** Pure static splits strand budget in quiet
namespaces while loud ones 409; pure dynamic (one shared pool, first
come first served) reintroduces the starvation bug at namespace
granularity. The hybrid:

- Every namespace gets a **guaranteed floor**: a static allocation that
  no other namespace can consume, borrow, or touch. Exhaustion of the
  floor is always survivable by neighbors.
- Above the floor, namespaces may **borrow from a shared pool** in
  bounded chunks, automatically, with an owner-visible alert. Borrowing
  never touches another namespace's floor.
- Each namespace also has a **ceiling** (floor + max borrow) so one
  namespace cannot drain the entire shared pool.

Budgets meter *sequence consumption* (events appended to the room log),
which is monotonic — there is no reclamation, so "borrowing" means
"permission to consume shared unallocated headroom," granted in chunks
and recorded in telemetry, not a loan that gets repaid.

### Concrete numbers for a 1M-event, 500-agent room

Anchored in measured data: ~6.5 events per claim lifecycle (fast-path
doc, swarm-100 exercise). Sanity-checking honest demand first:

- Claims: 500 agents x 30 lifecycles x 6.5 events ~ 97,500
- Chat: 500 agents x 200 messages x 1 event ~ 100,000
- Member lifecycle, work items, system events ~ 50,000
- **Honest total ~ 250k of 1M.** The 1M budget is ~4x honest demand.
  The binding risk is not rationing honest use — it is a runaway loop
  (thousands of events/minute from one lane). So floors can be generous;
  what matters is isolation + velocity, and exhaustion should be read as
  "probable runaway," not "room is full."

| Slice | Share | Events | Reasoning |
|---|---|---|---|
| Room reserve (wind-down) | 10% | 100,000 | keep today's `EVENT_BUDGET_RESERVE = 0.1` exactly; owner + `manage_claims` holders only |
| Shared borrow pool | 10% | 100,000 | unallocated headroom; namespaces draw in 5k chunks up to a per-namespace borrow cap |
| Namespace pool | 80% | 800,000 | split across namespaces |

Per-namespace example (20 namespaces, ~25 agents each): 40,000 per
namespace — ~3x that namespace's honest share (~12.5k). Split:

- **Guaranteed floor: 20,000** (50% of the namespace share). Never
  borrowable by anyone else. Covers ~3,000 claim lifecycles — far above
  honest demand, so hitting the floor means something is wrong, and the
  409 is doing its job.
- **Burst headroom: 20,000**, of which up to **10,000** may additionally
  be borrowed from the shared pool (ceiling = 50,000 per namespace).
  Auto-granted in 5k chunks; each grant fires the telemetry tripwire so
  the owner sees it.

Within a namespace the budget is **fungible across event types** (claim
lifecycle, chat, member commands). Deliberately no per-type sub-quotas:
a quiet-chat namespace must not be unable to claim because its "chat
slice" is full, and vice versa. Event-type mix is a telemetry/ops
concern (split counters by plane), not a quota concern.

Lane velocity (T2) example for a 25-agent namespace: token bucket per
`(namespace, lane)` at **60 events/minute sustained, burst 300**. Honest
machine-to-machine claim traffic fits comfortably; a retry storm trips
the 429 within seconds while the namespace floor stays intact for
everyone else.

Reserve sizing check: worst-case wind-down = close every open claim on
every board (20 namespaces x 200 open x ~3 events to close/release =
12k) + final receipts + archive note. 100k reserve is ~8x that. Generous
on purpose: the reserve is the last thing standing between a full room
and a disorderly one.

## 3. Enforcement points

Current write-path checks (all on `wave500/event-survival`, unchanged by
this design):

| Check | Location | Behavior today |
|---|---|---|
| Global hard cap | `server/store.mjs:3436` (apply path), `:4651` (command validation) | 409 `pilot_limit` at sequence >= 1M |
| Board budget reserve | `server/work-claim-integrity.mjs:119-131` (`assertBoardEventBudget`) | 409 `room_event_budget_low` when remaining < 10%, unprivileged board writes only |
| Board write call sites | `server/work-claim-routes.mjs:519, :551`; `:849, :906, :978, :1038` via `requireEventBudget` (`:760`) | board mutations (create/claim/update/close/...) |
| Budget visibility | `server/work-claim-routes.mjs:804` (`eventsRemaining` in response) | read-path exposure |
| Telemetry | `event_budget_remaining_ratio` gauge (`wave300/telemetry-prod:telemetry/gauges.mjs:23`) | "event-budget-low" tripwire |
| 429 + Retry-After precedent | `server/channel-send-budgets.mjs:107-118` (429 `send_budget_exhausted` + `Retry-After`), `server/agent-identities.mjs:229` (`fail(429, ..., { "Retry-After" })`) | honest transient refusal shape |

New enforcement (to be built):

1. **`assertNamespaceEventBudget(sequence, namespace, budgets,
   { privileged })`** in `server/work-claim-integrity.mjs`, next to
   `assertBoardEventBudget`. Same refusal shape as the existing one
   (`:125-126`): `{ error: { code, message }, eventsRemaining, hint,
   next: [{ command }] }`. Called at the existing board write call
   sites in `server/work-claim-routes.mjs` (the `:519/:551/:849/:906/
   :978/:1038` sites), namespaced by the write's target namespace
   (body `namespace` / `?namespace=`, defaulting to `default` exactly
   like board routing).
2. **Chat/message path.** Chat is the other big event source and today
   has *no* budget check at all (only board writes hit
   `assertBoardEventBudget`). Namespace attribution for chat: the
   sender's home namespace (their current board namespace, `default`
   unless set). Enforcement point: the message command validation path
   in `server/store.mjs` near `:4651`, or the message HTTP route —
   whichever owns the namespace attribution; the check itself lives in
   `work-claim-integrity.mjs` beside the board check so the two stay
   consistent.
3. **Lane velocity buckets** at the same choke points (board routes +
   message path), keyed `(namespace, lane)`. On exceed: **429
   `lane_event_rate_limited`** with a `Retry-After` header in seconds,
   following the `channel-send-budgets.mjs:118` pattern. Message names
   the lane, the limit, and the retry delay; nothing is queued.
4. **Privileged bypass** keeps today's shape: room owner and
   `manage_claims` holders bypass namespace and lane checks
   (`privileged` flag, cf. `mayManageAnyClaim(access)` at
   `work-claim-routes.mjs:760`). The reserve is theirs to spend winding
   the room down.
5. **Telemetry**: extend `event_budget_remaining_ratio` with a
   `namespace` label; add `namespace_event_consumption_total` (counter,
   by namespace and plane) and lane velocity counters. Tripwires at
   50% / 25% / 10% remaining per namespace — the 10% tripwire must fire
   *before* the first 409 so owners get warning, not surprise.

### New error codes (follow the `room_event_budget_low` pattern)

| Code | Status | When | Retry-After? |
|---|---|---|---|
| `namespace_event_budget_low` | 409 | namespace floor + borrow ceiling exhausted, unprivileged write | **No.** Lifetime budget does not regenerate. The `hint` says so honestly: ask the owner to raise the cap, or move to a new namespace/room. |
| `lane_event_budget_low` | 409 | explicit per-lane lifetime cap configured and exhausted | No — same terminal semantics. |
| `lane_event_rate_limited` | 429 | lane velocity bucket empty | **Yes**, seconds until the bucket refills. Transient; safe to retry. |
| `lane_event_budget_frozen` | 409 | owner froze the lane's event consumption via config (runaway kill-switch) | No — owner action required to unfreeze. |

Refusal semantics (WAVE-300 backpressure lane's law — **no silent
queuing**): a 409 means "this write will never succeed under the current
budget; do not retry blindly." A 429 means "slow down; retry after N
seconds; nothing was queued." A queued-but-unwritten event is a lie
about room state — the client was told the write landed when it did
not. Every refusal carries `eventsRemaining` (or bucket state),
a human-readable `hint`, and a machine-readable `next` action, exactly
like `room_event_budget_low` does today.

## 4. Starvation prevention

The design goal: **a lane that exhausts its budget must not take down
other lanes, and the room must always be wind-down-able.**

- **Floors are inviolable.** Borrowing draws only from the shared pool,
  never from another namespace's floor. A namespace at 0 remaining
  affects exactly that namespace's unprivileged writes.
- **Blast radius of exhaustion.** When namespace N is exhausted:
  N's unprivileged board writes and chat 409; N's reads are unaffected;
  every other namespace is unaffected; `?fast=1` writes are unaffected
  (Section 5); privileged (owner/manager) writes in N are unaffected.
  Newcomers can still join and work in any non-exhausted namespace.
- **Early warning, not surprise.** Per-namespace gauge tripwires at
  50/25/10% remaining, plus an alert on every borrow-pool draw. The
  first 409 in a namespace should never be the first signal.
- **Lane runaway kill-switch.** Owner config can freeze a lane's event
  consumption (`eventBudgets.lanes.<lane>.frozen: true` -> 409
  `lane_event_budget_frozen`) without touching the namespace or the
  room. Stops the bleed in one config write; unfreezing is equally
  cheap. The velocity 429s should contain most runaways before this is
  needed.
- **Reserve stays sacred.** The 10% room reserve remains owner/manager
  only (today's `privileged` bypass, extended to the namespace and lane
  checks). It is sized at ~8x worst-case wind-down (Section 2), so even
  a fully-exhausted room can be closed out cleanly: close claims,
  release lanes, post the archive note.
- **No cross-namespace debt.** Because sequence is monotonic and
  per-namespace spend is tracked as *spent-since-enable* counters (not
  sequence ranges), there is no way for accounting drift in one
  namespace to corrupt another's remaining-budget computation.

## 5. Interaction with `?fast=1`

**Position: `?fast=1` writes consume zero event budget. The budget gate
is skipped for fast writes, as it already is.**

This is not a new exemption — it is the existing fast-path contract.
From `wave300/data-plane-fastpath` (`docs/WORK-CLAIMS-FAST-PATH.md`):
fast selects the pure-state path (no `sweepRoom`, no `closeLiveClaims`,
no mutation room events, no wakes), and "Event-budget gate
(`requireEventBudget`): enforced; 409 `room_event_budget_low` | skipped
(no events emitted)." The fast-path test suite asserts "fast write with
exhausted event budget: succeeds (budget gate skipped)."

The argument, made explicit:

1. **The budget meters sequence consumption.** Fast emits zero room
   events. Charging budget for zero consumption would be metering
   nothing — the number would be arbitrary, and arbitrary meters are
   dishonest meters.
2. **Fast is the designed escape hatch for budget exhaustion.** The
   fast-path doc lists "any path where the event budget is the binding
   constraint" as a primary use case. Charging fast against the budget
   would deadlock the exact situation it exists to relieve: budget
   exhausted -> fallback needs budget -> nothing can move.
3. **Design law: "the database is the truth, events are just
   notifications."** The event budget is a *notification* budget — it
   prices room-log presence (timeline, digest, wakes). Fast explicitly
   forfeits all three. Opting out of notifications opts out of the
   notification budget, by construction.
4. **It is not a budget-evasion exploit.** Three reasons: (a) fast is
   the documented, visible path, not a loophole — using it is a
   declared tradeoff; (b) it forfeits exactly what the budget buys
   (visibility), so a lane "evading" budget via fast is choosing
   invisibility, which is self-limiting for any lane that needs humans
   or other lanes to see its work; (c) fast still pays *state* costs —
   per-board 200 open-claim caps, per-member 20 cap across boards,
   `workItemsPerRoom` 500, `projectionBytes` 4MB (`server/store.mjs:427`)
   all still apply. State abuse via fast shows up in the state caps and
   the reaper, not in the event log.
5. **Velocity accounting still sees fast writes.** T2 lane buckets
   count fast writes for *velocity* (abuse signal: a lane doing 10k
   fast writes/minute is still a runaway) but not against the
   *lifetime* event budget. Telemetry distinguishes the two; the budget
   does not charge for what it does not meter.

Fast reads likewise consume nothing: no sweep, no events, no charge.

## 6. Migration

**No behavior change until configured.** The feature is inert unless an
owner opts in.

- **Existing rooms get one default namespace.** `default` — the same
  name and convention as sharded boards, where claims without a
  namespace already read as `default`. No data migration: claims carry
  their namespace for life, and pre-sharding rows are already `default`.
- **Disabled by default.** When `eventBudgets` is absent from room
  config, every check in Section 3 is skipped and behavior is
  byte-identical to today (global 1M + 10% reserve board gate).
- **Enabling is non-breaking.** The owner enables via the existing
  config surface — `POST /api/rooms/{roomId}/work-claims/config`
  extended with an `eventBudgets` section (one config surface for board
  caps *and* budgets, owner-only). On enable, `default` is allocated
  the full non-reserve budget (900k), so enabling alone changes nothing;
  the owner then carves out namespace floors, which can only shrink
  `default`'s ceiling with explicit owner action.
- **No retroactive metering.** Per-namespace spend is tracked as
  *spent-since-enable* counters, not reconstructed from history. Events
  written before enablement are not attributed; the global 1M cap
  (`store.mjs:3436/:4651`) still bounds the sum, so pre-existing rooms
  near the cap keep today's protection.
- **Namespace validation** reuses the board-namespace rule
  (`^[A-Za-z0-9_-]{1,64}$`). Writes without a namespace attribute to
  `default`, exactly like board routing. Claim ids stay room-unique
  across namespaces, so budgets never interfere with `dependsOn` or
  provenance walks.
- **Config shape (sketch):**
  `{ "eventBudgets": { "enabled": true, "namespaces": { "guild-load":
  { "floor": 20000, "maxBorrow": 10000 } }, "lanes": { "<lane>":
  { "eventsPerMinute": 60, "burst": 300, "frozen": false } } } }`.
  Absent entries fall back to room defaults; `default` inherits the
  full non-reserve budget unless explicitly carved.

## Open questions (for the build lane, not this doc)

- Exact token-bucket parameters per lane size — the 60/min + 300 burst
  numbers are starting points; calibrate against the telemetry lane's
  measured per-lane velocity distributions.
- Whether chat's home-namespace attribution should follow the member's
  current board or be an explicit per-member setting (affects the
  Section 3 message-path check).
- Borrow-pool auto-grant vs owner-approved grants — this doc proposes
  auto-grant with alerts; a stricter room may want approval gates.

## References

- `server/store.mjs:427` (`PILOT_LIMITS`), `:3436`, `:4651` (409 `pilot_limit`)
- `server/work-claim-integrity.mjs:29` (`EVENT_BUDGET_RESERVE`), `:111`
  (`roomEventsRemaining`), `:119-131` (`assertBoardEventBudget` -> 409 `room_event_budget_low`)
- `server/work-claim-routes.mjs:519, :551, :760, :804, :849, :906, :978, :1038`
  (board write-path budget checks)
- `server/channel-send-budgets.mjs:107-118` (429 + `Retry-After` precedent),
  `server/agent-identities.mjs:229`
- `wave300/telemetry-prod:telemetry/gauges.mjs:23` (`event_budget_remaining_ratio`)
- `wave300/sharded-claim-boards:docs/WORK-CLAIM-BOARDS.md` (namespace model)
- `wave300/data-plane-fastpath:docs/WORK-CLAIMS-FAST-PATH.md` (`?fast=1` contract)
