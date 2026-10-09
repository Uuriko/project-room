# Wave-500 event-survival: existing-work survey (W3)

Surveyed 2026-10-08/09 by W3/17 on branch `wave500/event-survival`
(worktree `~/workspace/pr-wave500-event-survival`). Purpose: map every
related piece of wave / wave-300 work so this lane extends it instead of
duplicating it. Every claim carries a file:line reference.

## Ground truth (this branch)

- `PILOT_LIMITS` — `server/store.mjs:427`:
  `eventsPerRoom: 1_000_000`, `membersPerRoom: 100`,
  `workItemsPerRoom: 500`, `projectionBytes: 4 * 1024 * 1024` (4 MiB —
  the cap bounced 4→16→6→4→64→4 through the G11 saga; 4 MiB is current,
  per the G11 comment at `server/store.mjs:421-426`).
- Hard death at exhaustion — `server/store.mjs`:
  - `:3436` — command apply path: 409 `pilot_limit` when
    `room.sequence >= eventsPerRoom` (or active members ≥ 100).
  - `:3443` — 409 `pilot_limit` when `Buffer.byteLength(projection) >
    PILOT_LIMITS.projectionBytes`.
  - `:4651` — command validation: same 409 at sequence ≥ 1M (cleanup
    commands bypass via the `cleanup` carve-out at `:4649`).
  - `:4787` — history import: projection-byte 409.
  - After a 409 nothing is automatic — the room is effectively dead but
    still advertises itself as live (W11's framing).
- Message body envelope cap: `MAX_MESSAGE_BODY_CHARS = 65536`
  (`src/events.js:15`); the envelope admits message bodies up to that
  (`src/events.js:624-626`). `postMessage` (`src/events.js:1134`) pushes
  the full `body` into `state.messages`, i.e. bodies still ride the
  in-memory projection — but see "Bodies-at-rest (shipped)" below.

---

## 1. WAVE-300 data-plane fastpath — `?fast=1` (sibling branch, unmerged)

**Ref:** `wave300/data-plane-fastpath`. Commits:
`08aa64fe7` (design doc), `ea052605f` (feature), `08bdf80c8` (openapi),
`18f6fc13d` (tests + BOARD_QUERY).

**What it built.** A side-effect selector, not a new API:
`?fast=1` on any `/api/rooms/{roomId}/work-claims/*` route (and
`fast: true` on MCP `room_close_work_claim` / `room_link_work_claim_pr`).

| Behavior | Default | `?fast=1` |
|---|---|---|
| Lease sweep on read | `sweepRoom` runs (rewrite + `lease_expired` event + wake per lapsed lease) | skipped |
| `closeLiveClaims` on read | runs (writes on GET) | skipped |
| Mutation room events | one `work_claim.updated` per commit | none; `registry.set` only |
| Wakes (`enqueueClaimWake`, `wakeNamedReviewers`, `noteReadyWork`) | fire | skipped |
| Event-budget gate (`requireEventBudget`) | enforced; 409 `room_event_budget_low` | skipped (no events emitted) |

Key lines: `BOARD_QUERY` gains `"fast"`
(`server/work-claim-routes.mjs`, diff hunk @@ -139); the fast flag is
parsed in `handleWorkClaims`
(`const fast = options.url?.searchParams?.get("fast") === "1"`);
`closeWorkClaim` / `linkWorkClaimPullRequest` take `fast = false` and
skip both `assertBoardEventBudget` and `emitWorkClaimEvent` when true.
Design law: **"the database is the truth, events are just
notifications"** (`docs/WORK-CLAIMS-FAST-PATH.md:1-3`).

**Files:** `docs/WORK-CLAIMS-FAST-PATH.md` (design),
`server/work-claim-routes.mjs` (+53/−17),
`server/mcp-full-profile.mjs` (fast passthrough),
`docs/openapi.yaml` (WorkClaimFast query param),
`tests/work-claims-fast-path.test.js` (6/6 passing per commit message).

**What it measured** (`docs/WORK-CLAIMS-FAST-PATH.md:13-22`, swarm-100
exercise Oct 2026): the default claim path commits ~6.5 room events per
claim lifecycle against the room's 1M-event lifetime budget; 200 agents
exhaust the budget in ~3 h. Fast path takes that to **0 events per
lifecycle**. Fast tests assert: fast create→claim→update→release
persists state with zero `work_claim.updated` events and zero wakes,
and a fast write with an exhausted event budget succeeds (budget gate
skipped).

**Where it STOPS (our gap).**
- Fast covers only work-claim routes. Chat (`message.posted`), member
  lifecycle, and every other event type still burn budget at the
  default rate.
- Fast is opt-in per request. There is no policy, default, or
  auto-fallback that steers chatty machine lanes onto it; a lane under
  budget pressure must know to ask.
- Fast exempts budget but still pays state costs (board caps, 4 MiB
  projection, reaper) — nobody owns the guidance for when fast is the
  right escape hatch vs. a budget-evasion path (W17 §1.2 calls this a
  designed bypass).
- NOT merged into `wave500/event-survival` (lives only on the wave300
  branch; merge/land status unknown).

## 2. WAVE-300 telemetry-prod — trip-wire gauges (sibling branch, unmerged)

**Ref:** `wave300/telemetry-prod`. Commits: `bc2b675ab` (5 gauges +
`/api/health/tripwires`), `59c95a081` (ops dashboard),
`d5a316160` (live load report), `a61e07c29` (p99 unit fix).

**What it built.** Five server-side gauges in the live trip-wire
registry (`server/tripwires.mjs:27-40` on that branch), contract view at
`telemetry/gauges.mjs:21-27` (kebab-case names, `{value, threshold,
status}` with critical→"trip"):

| # | Contract (`telemetry/gauges.mjs`) | Internal (`server/tripwires.mjs`) | Dir | warn | trip |
|---|---|---|---|---|---|
| 1 | `event-budget-low` | `event_budget_remaining_ratio` | low | 0.2 | 0.1 |
| 2 | `write-limiter-penalty-box` | `write_limiter_penalty_entries` | high | 5 | 20 |
| 3 | `sse-event-loop-saturation` | `event_loop_delay_ms_p99` | high | 50 | 200 |
| 4 | `projection-size-growth` | `projection_bytes_ratio` | high | 0.7 | 0.9 |
| 5 | `commands-silent-timeout-rate` | `commands_silent_timeout_ratio` | high | 0.1 | 0.3 |

**Files:** `server/tripwires.mjs`, `server/http.mjs` (hook points),
`telemetry/gauges.mjs`, `telemetry/ops-dashboard.html`,
`telemetry/capture-baseline.mjs`, `telemetry/build-dashboard-data.mjs`,
`telemetry/tripwire-contract.test.mjs`, plus findings/seed/example
JSON. Design load-bearing constraints (per W16's
`docs/wave500/TELEMETRY-EXTENSION.md`): trip-wire checks emit zero room
events, zero read-path writes, no expensive reads per request.

**What it measured** (`telemetry/TRIPWIRE-LOAD-REPORT.md`, live load
window 2026-10-08, 252.9 s, pilot limits 1M events / 4 MiB projection):
- 150-request burst → 32 ok, 118× 429; `write_limiter_penalty_entries`
  0→238 (**critical**, the most sensitive wire — 5 refusals/15 min
  warns).
- `event_budget_remaining_ratio` Δ −1.0e-6/event (exactly
  `1/eventsPerRoom`); warn (< 0.2) needs ~800k events — "effectively
  never fires at these limits" (HEADROOM-MEASURED).
- `projection_bytes_ratio` Δ ≈ +7.5e-5/event (~315 B/event at this
  message size); warn (> 0.7) needs ~9,300 events; critical (> 0.9)
  ~11,900.
- Zero-room-event verification: trip-wire reads added 0 room events
  (2→2, 125→125).
- Findings for Worker B/C (open at report time): `event_loop_delay_ms_p99`
  had a ×1e6 unit error (nanoseconds vs ms) and an empty-histogram
  false-critical — fixed by `a61e07c29`.

**Where it STOPS (our gap).**
- It *measures* budget burn; it does not *ration, reclaim, or rotate*.
  No enforcement, no compaction, no namespace breakdown.
- Gauges 1 and 4 are room-global; there is no per-namespace or
  per-lane cut (W16's extension spec adds those — see §7).
- NOT merged into `wave500/event-survival`.

## 3. WAVE-300 sharded claim boards — namespaces (sibling branch, unmerged)

**Ref:** `wave300/sharded-claim-boards`. Commits: `904ca3e5f` (spec),
`f2055c7f3` (routing + per-board caps + read-merge), `fca324073`
(openapi + config shape).

**What it built.** A room's claim board sharded by **namespace**
(`^[A-Za-z0-9_-]{1,64}$`; `default` is the pre-sharding board): each
board has an independent open-claim cap (default 200; the old single
board's cap); per-member cap (default 20) counts across all boards;
claim ids stay room-unique; `?namespace=` routing on all claim routes;
`?namespace=*` read-merge global view; `GET …/work-claim-boards` lists
boards. Full board refuses 409 `work_board_full` naming the board.

**Files:** `docs/WORK-CLAIM-BOARDS.md` (spec),
`server/work-claim-routes.mjs`, `server/work-claim-sqlite.mjs`,
`server/work-claims.mjs`, `server/http.mjs`, `docs/openapi.yaml`,
`tests/work-claim-boards.test.js`.

**What it measured:** none — spec + implementation + tests; no load
numbers in the spec. Motivating data point cited: 92% of the 200-cap
single board was unclaimed scratch (from the spec's problem statement).

**Where it STOPS (our gap).**
- Sharding isolates *claim slots*, not *events*. A namespace's boards
  cap its open claims; nothing stops its lanes from burning the
  room-global 1M event budget. This is exactly the gap W7's budget
  design fills (budgets "follow the same isolation boundaries").
- Namespace is a board concept only; chat and other event types have
  no namespace attribution.
- NOT merged into `wave500/event-survival`.

## 4. WAVE-300 payload store — content-addressed blobs (sibling branch, unmerged)

**Ref:** `wave300/payload-store` (exists — 3 commits, not missing).
Commits: `71317bcba` (design doc), `971b89af2` (tests first),
`f86422b85` (store impl), `8d9949bc4` (routes + refs + message-post
wire-in).

**What it built.** `payload_blobs` (sha256 → bytes, global scope,
cross-room dedup) + `payload_pins` (event|claim|attachment × room ×
ref) with pin-set GC (delete iff older than 24 h AND zero pins).
Payloads ≤ 64 KiB ride inline in event bodies; larger are uploaded via
`POST /api/rooms/{room}/payloads` (201/200 dedup, 413 > 25 MiB, 422 bad
shape) and referenced by hash. The `message.posted` path externalizes
> 64 KiB inline payloads, pins refs in the same transaction as the
event write, and 413s bare > 64 KiB base64 data fields
(`8d9949bc4` commit message).

**Files:** `docs/PAYLOAD-STORE.md` (design — note: `:9` still says
"design doc… no implementation code", stale; implementation followed in
`971b89af2`/`f86422b85`), `server/payload-store.mjs`,
`server/payload-refs.mjs`, `server/payload-schema.mjs`,
`server/http.mjs` (routes), `scripts/runtime-package.mjs` (allowlist),
`docs/openapi.yaml`, `tests/payload-store.test.mjs`,
`tests/payload-routes.test.mjs` (17 tests, passing).

**What it measured:** none published — no load report; the 64 KiB
threshold rationale is in `docs/PAYLOAD-STORE.md` §1 ("a room of
all-inline events still holds tens of thousands of small payloads
before the projection cap bites").

**Where it STOPS (our gap).**
- It externalizes *large payloads/attachments*, not *message bodies*.
  Ordinary chat text (the dominant projection bytes, per G11) still
  rides inline in events and the projection (bodies-at-rest, below, is
  the mechanism that handles bodies — different lane, already in
  `main`).
- It is about bytes, not event count: externalizing a payload does not
  reduce the number of room events (the event row still exists, now
  carrying a hash).
- R2 backend is a documented future (`BlobBackend` interface); this
  slice is local SQLite only.
- NOT merged into `wave500/event-survival`.

---

## 5. On-branch wave500 lane work (all committed here unless noted)

### W7 — per-namespace / per-lane event budgets (design)
`docs/wave500/EVENT-BUDGET-DESIGN.md` (commit `3073b3e76`). Three tiers:
T0 room (exists today: 1M + 10% reserve), T1 per-namespace
(floor + burst + borrow-from-shared-pool + ceiling; 409
`namespace_event_budget_low`), T2 per-lane velocity throttle (token
bucket per `(namespace, lane)`, 429 `lane_event_rate_limited` with
`Retry-After`; per-agent hard lifetime quota explicitly *rejected*).
Honest-demand math (§2): ~250k events of 1M for 500 agents (~4×
headroom); the binding risk is a runaway loop, not rationing. Position
on `?fast=1` (§5): fast writes consume zero event budget (existing
fast-path contract); lane buckets still count fast writes for
*velocity* but not lifetime budget. Migration: disabled by default,
no behavior change until the owner enables `eventBudgets` in room
config. **STOPS at design** — no enforcement code; W8 prototypes the
allocator as pure functions.

### W8 — budget allocator prototype (code, pure)
`server/event-budget.mjs` + `tests/event-budget.test.js` (commit
`733ca161c`, 138 + 101 lines). Pure functions, no DB/store coupling:
reserve ratio 0.1, floor allocations, borrow only from the unallocated
pool (borrowRatio 0.5 per call), honest refusals
(`namespace_event_budget_exhausted` / `namespace_event_budget_unknown`,
`retryAfterSec`). **STOPS at pure functions** — no persistence (restart
resets every counter; W17 §4.2 flags this as double-spend-by-default),
no multi-instance CAS (W17 §4.1), no wiring into the write path, and
the `?fast=1` bypass is unmodeled (W17 §4.3).

### W10 — coalescing prototype (code, pure)
`server/event-coalesce.mjs` + `tests/event-coalesce.test.js` (commit
`9d0d868f4`, 55 + 58 lines). `coalesceUpdateLog` merges consecutive
same-claim update entries within a 60 s window of the first entry
(first/last timestamps, concatenated notes, update count). **STOPS at
pure functions** — no store coupling; W17 §4.4–4.6 flag restart-unsafe
merging, unbounded merged-note bodies, heartbeat-suppression killing
the liveness signal, and lost per-update attribution.

### W11 — room rotation / archival at budget exhaustion (design)
`docs/wave500/ROOM-ROTATION-DESIGN.md` (commit `d0454b5b1`). Watermarks
75/85/95/100% on OR(event seq/1M, projection/4 MiB); server-side
`rotation-watch` job (1/min, single-writer); rotation claim →
freeze → snapshot → successor room (sequence restarts at 0; open claims
re-created as new rows with `predecessor_claim_id`; members re-created,
credentials NOT carried) → old room `room.archived` → terminal
`room.rotation_complete` + SSE `room_rotated` frame. Documents today's
ground truth: archival is owner-initiated and terminal
(`rooms.archived_at`, schema v28; `refuseArchivedWrite` in
`server/room-lifecycle.mjs`); there is no successor, no redirect, no
auto-rotation. **STOPS at design** — no implementation; W17 §1.4
attacks it (re-auth storm against `membersPerRoom: 100`, identity
fragmentation, freeze carve-outs).

### W4 — event compaction / archiving (design)
`docs/wave500/COMPACTION-DESIGN.md` (commit `f839a5232`). Class A
(summarizable: claim updates, renewals, reactions, edits…), Class B
(load-bearing: membership authority, genesis, money/receipts,
audit-of-audit — never summarized), Class C (droppable after
summarization). `compaction.summary` + `compaction.window` events
appended as normal log events; raw rows moved to `events_archive`
table; 70% watermark trigger; sequences never renumbered (gaps +
`compacted` envelope / `compaction.notice` SSE discontinuity contract);
compaction summaries classified as cleanup commands so a pass can land
at 100% budget. **STOPS at design** — no implementation; W17 §1.1/§3
calls it the most dangerous change (destroys the immutable-log
property `_restoreBodiesFromLog` depends on).

### W17 — adversarial review (review doc)
`docs/wave500/ADVERSARIAL-REPORT.md`… actually
`docs/wave500/ADVERSARIAL-REVIEW.md` (commit `28e9e3aab`). Attacks the
lane's own designs: (P1) `membersPerRoom: 100` means a 500-agent room
can't exist yet; (P2) measured projection binds ~10–15× before events,
so "event-survival" meters the wrong resource; (P3) the cap moved six
times — don't tune to 4 MiB; (P4) bodies-out-of-projection already
shipped (see §6 below). Ranks leverage: #1 lane velocity throttles
(T2), #2 bodies-at-rest hardening, last compaction ("negative
leverage… irreversible"). **STOPS at review** — no rebuttal or
build decisions recorded.

### W16 — telemetry extension (landed)
`docs/wave500/TELEMETRY-EXTENSION.md`,
`server/event-survival-metrics.mjs`, `tests/event-survival-metrics.test.js`
(commit `6b83910e3`, 591 lines). Spec for the wave300 telemetry-prod
lane: 3 new gauges (`namespace-budget-low`,
`compaction-ineffective`, `rotation-watermark-high` with
`GAUGE_DEFS`/`CONTRACT_VIEW`/`EXPECTED_GAUGES` additions), a new
`GET /api/health/event-survival` endpoint shape, and dashboard cards.
Pure math helpers (`namespaceUsage`, `compactionStats`,
`rotationWatermark`) with injected caps. **STOPS at spec + pure
helpers** — the telemetry-prod lane must wire them into
`server/tripwires.mjs` / `telemetry/gauges.mjs` / the dashboard; the
collector hook points (namespace counters, compaction-sweep hook,
rotation-watermark scan) don't exist yet.

### In-flight (uncommitted, sibling workers — do not touch)
- `tests/event-cost-measurement.test.js` (W1): measures `events` rows
  per operation on default vs `?fast=1` paths.
- `tests/projection-cost-measurement.test.js` (W2): per-op projection
  byte deltas; references `docs/wave500/PROJECTION-COST-TABLE.md`
  (does not exist yet — W2 is mid-flight).
- `tests/swarm-event-burn.test.js` (W13): swarm-scale burn of both
  pilot budgets.

---

## 6. Main-branch mechanisms (already in the tree)

### Note-only coalescing (live)
`server/work-claim-events.mjs:139-161`: SEC-2/Q3-A — note-only writes
(a note on a held claim, a review note, a lease renewal) coalesce into
at most one room event per claim+action per 60 s
(`CLAIM_EVENT_COALESCE_MS = 60_000`, `:145`; memory cap 10,000 entries,
`:146`). Transitions, assignments, verdicts, PR facts are never
coalesced. Memory-only per store — a restart allows one extra event
per claim. Call sites: `reviewed` at
`server/work-claim-routes.mjs:1161`, `renewed` at `:1295`
(`coalesce: true`). W10's prototype is the "extended" version of this;
it does not replace it.

### Board event-budget gate (live)
`server/work-claim-integrity.mjs:29` (`EVENT_BUDGET_RESERVE = 0.1`),
`:109-113` (`roomEventsRemaining`), `:117-128`
(`assertBoardEventBudget` → 409 `room_event_budget_low` when < 10% of
1M remains; privileged owner/`manage_claims` bypass). Enforced at
board write call sites via `requireEventBudget`
(`server/work-claim-routes.mjs:760`; call sites :849, :906, :978,
:1038, :1140, :1154, :1180, :1191, :1231, :1266, :1338). **Chat has no
budget check at all** (W7 §3 states this; only board writes hit the
gate).

### Bodies-at-rest — message bodies out of the projection (SHIPPED)
`server/projection-at-rest.mjs` — header `:1-25`: "Phase 1a: message
bodies at rest outside the room projection row." Bodies ≥
`BODY_AT_REST_MIN_CHARS = 256` (`:21`; 256 not 512 since 2026-10-07 —
38% of recent muse-room bodies are 256–511 chars) are replaced by
`bodyRef` (sha256) in the stored projection row; text kept once in the
`projection_bodies` table keyed by content hash; a trigger on `rooms`
deletes unreferenced bodies on each projection write. Landed in commit
`382dbb28f` ("perf(storage): move bodies >= 256 chars out of room
row"). Wired in `server/store.mjs`: import `:45`,
`storedProjection(roomId, state)` `:2686-2687` (used on every
projection write: `:2536`, `:2565`, `:2578`, `:3442`, `:4123`,
`:4786`, `:5003`), fail-closed `_restoreBodiesFromLog` `:2691`
(replays the event log to refill missing bodies; 500
`projection_corrupt` if it can't), `rehydrateAllProjections()` `:2673`.
The G11 comment at `server/store.mjs:421-426` says it outright:
"Keep the application guard at 4 MiB. Bodies-at-rest supplies
projection headroom."

---

## 7. The four specific callouts

### (1) Does anything already do event compaction/archiving? — NO (code), design only.
- W4's `docs/wave500/COMPACTION-DESIGN.md` is the only compaction
  design; it has no implementation.
- The `events` table has no pruning. The single `DELETE FROM events`
  in `server/store.mjs:4120` is inside the owner-only history
  *import/replace* path, not compaction.
- Message redaction (PRIV-1, `src/events.js` `postMessage` redacted
  path) nulls bodies in a rewritten log — privacy, not budget
  reclamation.
- W17 §1.1/§3 actively argues compaction should never be built
  (irreversible, destroys the immutable-log property that
  `_restoreBodiesFromLog` depends on; "negative leverage").
- **Gap:** if this lane wants reclamation, it must either build W4's
  design (contested) or define a narrower alternative (e.g. Class-C-only
  deletion, or archive-then-delete with the audit guarantees W4 §4
  demands). Nothing is assigned.

### (2) Per-namespace or per-lane event budgets? — DESIGNED + PROTOTYPED, not enforced.
- Live today: exactly one budget per room — the 1M global cap
  (`server/store.mjs:427, :3436, :4651`) plus the 10% reserve gate on
  board writes (`server/work-claim-integrity.mjs:29, :117-128`).
  Chat/message writes have no budget check.
- W7 designed T1 (per-namespace floors/borrow/ceilings) + T2
  (per-lane velocity throttle, 429; per-agent lifetime quota rejected)
  — `docs/wave500/EVENT-BUDGET-DESIGN.md`, design only.
- W8 prototyped the T1 allocator as pure functions —
  `server/event-budget.mjs` (commit `733ca161c`) — not wired to any
  write path, no persistence, no multi-instance safety.
- T2 lane velocity throttles are unbuilt everywhere (W17 ranks them the
  #1 highest-leverage change; the only precedent is the unrelated
  429 + `Retry-After` shape in `server/channel-send-budgets.mjs:107-118`).
- **Gap:** enforcement. The budget *math* exists (W7/W8/W16 helpers);
  the write-path *gates*, the namespace spend counters, the lane
  buckets, and the chat-path attribution do not.

### (3) Message-bodies-out-of-projection — "Claude's design": the design doc was NOT found; the implementation SHIPPED.
- The exact sentence lives in commit `ad2c26127` ("G11 stopgap: raise
  room caps and read the event cap from one place"): "The real fix
  (message bodies out of the projection) is Claude's design." The
  follow-up `aed67719b` (G11b) closes with "The real fix stays Phase 1
  (message bodies out of the projection)."
- Hunt result: **no design doc for this exists in `docs/` or in git
  log** (searched all branches for "out of the projection", "body
  store", "message store" — zero hits; the phrase appears only in the
  two G11 commit messages).
- But the *substance* is in production: `server/projection-at-rest.mjs`
  ("Phase 1a: message bodies at rest outside the room projection
  row", commit `382dbb28f`), wired through `server/store.mjs`
  (`storedProjection` `:2686-2687`, `_restoreBodiesFromLog` `:2691`).
  The G11 comment at `server/store.mjs:421-426` confirms the intent:
  "Bodies-at-rest supplies projection headroom."
- W17 §1.3 agrees the mechanism is shipped and says the remaining
  work is *maintenance*: `_restoreBodiesFromLog` is fail-closed (a
  missing body row 500s every room read) and replays the *entire event
  log* on the read path — at 1M events that replay is a DoS. "The
  design work is done; what remains is the one failure mode nobody is
  assigned to."
- **Gap:** bodies-at-rest restore-path hardening (bounded replay,
  degraded-read mode). Also: the trigger only slims the *stored row*;
  the event *rows* (`events.body`) still carry full text, and the
  in-memory projection still holds full bodies — "bodies out of the
  projection" is true for the DB row, not for the log or memory.

### (4) Room rotation/archival at budget exhaustion? — DESIGNED (W11), not built.
- Live today: owner-initiated `room.archived` is terminal
  (`rooms.archived_at`, schema v28; `refuseArchivedWrite` in
  `server/room-lifecycle.mjs` makes it read-only; reads/streams/export
  keep working). It creates no successor, carries nothing over,
  redirects nobody. At exhaustion the room just 409s (`pilot_limit`,
  `server/store.mjs:3436/:3443/:4651/:4787`) — "the room never dies
  without a terminal event" is aspirational, not current.
- W11's `docs/wave500/ROOM-ROTATION-DESIGN.md` designs the full
  rotation (75/85/95/100% watermarks, rotation-watch job, claim →
  freeze → snapshot → successor at sequence 0 → archive → terminal
  `room.rotation_complete` + SSE `room_rotated` frame). Design only;
  the `room_rotations` table, rotation events, and the watch job do not
  exist.
- **Gap:** the entire rotation build, plus its open questions (auto-claim
  at 95% without an owner online; event-body bytes having no per-room
  cap; SSE terminal-frame shape).

---

## 8. Net gaps for the event-survival lane (extend, don't duplicate)

Built or live — use, don't rebuild: `?fast=1` zero-event claim path
(wave300 branch); 5 trip-wire gauges + load report (wave300 branch);
sharded boards namespaces (wave300 branch); payload store (wave300
branch); note-only coalescing (live); 10% board budget gate (live);
bodies-at-rest Phase 1a (live).

Designed/prototyped — the lane's actual backlog:
1. **Budget enforcement** (W7 §3 + W8): wire gates into board routes
   and the message path; persist per-namespace spend; multi-instance
   safety. Chat attribution is undecided (W7 open question).
2. **Lane velocity throttles** (T2): unbuilt; W17's #1 leverage pick;
   ~100 lines at existing 429 choke points.
3. **Bodies-at-rest restore hardening**: bounded replay / degraded-read
   for `_restoreBodiesFromLog` (`server/store.mjs:2691`) — the one
   shipped fragility nobody owns.
4. **Compaction**: designed (W4), fiercely contested (W17) — needs a
   lane decision (build / narrow / shelve), not another design.
5. **Rotation**: designed (W11) — needs the build; open questions 1–3
   in the doc.
6. **Telemetry wiring** (W16 spec): the wave300 telemetry-prod lane
   must adopt the 3 new gauges + `/api/health/event-survival` +
   dashboard cards; collector hook points don't exist yet.
7. **Measurement** (W1/W2/W13 in-flight, untracked): don't duplicate
   their harnesses; consume `PROJECTION-COST-TABLE.md` when W2 lands.

Structural caveats from W17 worth keeping: `membersPerRoom: 100`
(P1 — a 500-agent room can't exist yet); the projection binds ~10–15×
before events (P2 — meter the scarce resource); the 4 MiB cap moved six
times (P3 — design under cap uncertainty, don't tune to 4 MiB).
