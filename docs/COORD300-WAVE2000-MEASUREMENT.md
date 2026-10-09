# COORD-300 GUILD-02 — WAVE-2000 coordination measurement

**Branch:** `coord300/guild-02` · **Worktree:** `~/workspace/pr-coord300-guild-02/`
**Coordinator:** COORD-300 guild-02 (depth 2/2, can_spawn=no)
**Status:** measurement complete; one coordinator rollup at end (`scratch/DONE-ROLLUP.md`)

## 0. Redirect acknowledgment (Dot, room seq 8263)

This guild's original brief (spawn 50 measurement workers, validate the
wave500/coord-cost model) was **redirected by Dot** — John's designated
orchestration authority — to: *"re-aim from 'build new' to 'repair observed
coordination failures'"*. Concretely:

- **No additional workers launched.** The 50-worker measurement pool was
  stood down before spawning; all measurement below was done by the
  coordinator directly, read-only.
- **Honest accounting only:** planned vs spawned vs runnable vs finished are
  reported as four separate numbers. Token/compute cost is reported ONLY
  from receipts — with none available, cost is the string `unknown`, never
  an estimate.
- **No live load generation.** No room API polling loops, no mass refetching,
  no new parallel queue, no board/protocol changes, no permission changes.
  Everything additive and offline/fixture-backed.
- Deliverable shape per Dot: exact branch-head SHA (in rollup), a runnable
  test, a negative control, integration dependencies (§10), and an explicit
  "what is NOT proven" section (§11).

## 1. Method

`scripts/measure-wave-overhead.mjs` parses the launcher ledger, the claim
registry, and a captured `git ls-remote` ref list into one accounting object.
Default mode is offline (fixtures); `--live` reads the real inputs. The
script never writes to the room, never spawns agents, never generates load.

```
node scripts/measure-wave-overhead.mjs            # offline, fixture ledger
node scripts/measure-wave-overhead.mjs --live     # real ledger+claims+refs
node scripts/measure-wave-overhead.mjs --live --json
```

Tests: `node --test tests/coord300-wave-accounting.test.js` (8 pass, incl.
negative control). Fixtures: `tests/fixtures/coord300/ledger-clean.md`,
`tests/fixtures/coord300/ledger-poisoned.md`.

## 2. The four counts (WAVE-2000, N=2040 design)

| Count | Value | Provenance |
|---|---|---|
| **planned** | 2040 (40 guilds × 50 workers + 40 coordinators) | wave design, ledger header |
| **spawned** (coordinators) | 40/40 | ledger: all launched by 08:08 ledger-time |
| **spawned** (workers, unique) | 250 (G01–G05 × 50) | ledger 50/50 milestones; respawns excluded (replacements, not new) |
| **drain killed / respawned** | 11 killed ~10:00, all respawned by 10:10 (ledger-time) | ledger SYSTEM DRAIN INCIDENT |
| **runnable** (live & working) | ~290 (latest heartbeat, ledger-time 14:00) | launcher estimate; **approximate** |
| **finished** (timestamped DONE) | 1 guild (29 @ 08:19 ledger-time, branch `wave2000/guild-29` @ `941f7172f979`) | ledger DONE line |
| **finished** (prose-reported) | 3 guilds (22, 26, 31 — "completed before their notice") | weaker evidence; kept separate, no timestamps |
| **branches on origin** | 7/40 (`wave2000/guild-20,22,26,27,31,33,40`) | `git ls-remote`, captured to `scratch/refs-wave2000.txt` |
| **costs** | `unknown` | no token/compute receipts exist anywhere observed |

Notes:

- Guild 29 is DONE but its branch is **not on origin** (committed locally @
  `941f7172f979`, never pushed). DONE ≠ visible. Guilds 22/26/31 are
  prose-reported done AND have origin branches; guild 29 is done with NO
  origin branch — a push/visibility gap, not a duplicate.
- Worker-level "finished" is **unknown**: the ledger tracks spawn milestones
  per guild, not per-worker completion. No per-worker DONE records exist.
- The runnable count (~290) exceeds unique spawns (40+250=290) exactly —
  consistent, but it is the launcher's own estimate, not an independent
  census. Treat as approximate.

## 3. Queue wait (worker spawn-phase durations, ledger-time)

Lower bounds (completion − first *observed* signal; true start is earlier):

| Guild | Spawn phase (ledger-time) | Cadence context |
|---|---|---|
| G01 | ≥ 35 min (pilot 08:35 → 50/50 @ 09:10) | 4/batch, congestion + 3-min drain pause |
| G02 | unknown (no start signal logged) | — |
| G03 | unknown (no start signal logged) | includes drain incident |
| G04 | ≥ 35 min (first signal 11:00 → 50/50 @ 11:35) | 2/batch |
| G05 | ≥ 100 min (10/50 @ 11:50 → 50/50 @ 13:30, incl. 45-min plane pause) | 2/batch → plane critical → single-spawn |
| G06 | in progress (8/50 @ 14:00) | single-spawn ~20 s cadence, "reliable" |

Effective per-spawn cost under contention (ledger-time deltas, includes
retries/backoff/pauses): G01 ≈ 210 s, G05 ≈ 165–300 s, G06 ≈ 20 s
(post-recovery). Per-worker queue-wait *distribution* is unknown — only
guild-level bounds are logged.

Spawn-plane degradation timeline (the failure cliff, not a smooth curve):

- 4/batch back-to-back "stable" → 5+ triggers lock timeouts
- ~10:00: success 50–75%, frequent lock timeouts; 2–3/batch with drains
- ~10:00: runtime restart drain kills 11 workers (G01: 11,12,17,28,36;
  G02: 1,10,14,28,34; G03: 1); all respawned by 10:10
- 12:45: PLANE CRITICAL — "Broken pipe", 90 s timeouts; spawns paused
- 12:55: PLANE UNSTABLE — intermittent "Broken pipe" DB errors; extended pause
- 13:30: plane recovered; single-spawn cadence with pauses

## 4. Duplicate work

- **WAVE-2000 duplicate guilds: none observed.** Claim registry: 17
  `wave2000-guild-*` claims, zero duplicate guild numbers. Origin: 7
  `wave2000/guild-*` branches, each guild at most once.
- **Data-quality flag (not duplicate work):** `wave2000-guild-28` is claimed
  with lane=`--lane` — looks like a CLI arg-parsing leak. The registry
  accepts it silently; a schema check on lane names would catch this class.
- **Historical context:** WAVE-1000 ran two concurrent launchers that
  duplicated guilds 05/08/15/18 (per this wave's ledger header). The
  single-canonical-launcher rule + 60-min heartbeat in the ledger header is
  the repair — and it held for WAVE-2000 (no second launcher observed).
- 11 drain respawns are replacements, not duplicate work.

## 5. Review latency

Mostly **unknown**: no PRs exist in this wave by design, and no worker-phase
guild has reached DONE, so worker-output → coordinator-integration → DONE
latency has zero completed samples. One data point: guild 29 (coordinator
direct build, no workers) went spawn → DONE in ~16 min ledger-time
(~08:03 → 08:19). Everything else is in-flight.

## 6. Room events: the zero-event regime

- The live room events API returns **401 `unauthenticated`** without an
  enrolled agent identity (observed 2026-10-09, op id `op_Lrzq1YiW`).
  Minting an identity would violate the no-credentials rule — the same
  reason the WAVE-2000 launcher skipped per-guild GUILD-CHARTER/DONE-ROLLUP
  posts wave-wide. This guild likewise filed its charter/rollup as branch
  files (`scratch/GUILD-CHARTER.md`, `scratch/DONE-ROLLUP.md`).
- **Measured: the wave emits 0 coordination room events by design.**
  Coordination runs through the ledger file, git branches, and parent-agent
  handoffs. The model has no zero-event regime (its floor is 3,060 events
  at N=2040 with all levers — §8).

## 7. Coordination friction log (observed failures)

1. **Depth constraint** (structural): guild coordinators at depth 2/2 have
   `can_spawn=no` — they cannot spawn their 50 workers. Repair: the
   launcher (depth 1/2) spawns all workers centrally as its own children.
   Consequence: spawn contention centralizes at one launcher; a plane pause
   stalls the entire wave (observed 12:45–13:30).
2. **Spawn-plane failure cliff** (§3 timeline): not graceful degradation —
   lock timeouts → 50–75% success → "Broken pipe"/90 s timeouts → full
   pause. Two pauses in ~1 h of ledger time.
3. **Drain incident**: 11 workers killed by a runtime restart drain; 10-min
   respawn window; no work-loss accounting exists (respawn = "still useful,
   still burn" per ledger — the burn is unmeasured).
4. **Clock skew**: ledger timestamps run **~80 min ahead of wall clock**
   (last entry 14:00 PDT written at file-mtime 12:40 PDT real; earlier
   sample showed ~64 min — unstable). Absolute ledger times are unusable;
   inter-entry deltas are usable only if skew is constant within a writer
   (unproven). Any future wave instrumentation must validate agent-written
   timestamps against filesystem mtime.
5. **Push gap**: guild 29 DONE with no origin branch (§2).
6. **Claim-registry hygiene**: the `--lane` lane name (§4).

## 8. Model validation — wave500/coord-cost vs WAVE-2000 actuals

Model predictions at N=2040 (the model's own `scripts/overhead-model.mjs`,
`--levers=batch,digest,standing`, tasks/agent=1):

| | Model naive | Model all-levers | WAVE-2000 actual |
|---|---|---|---|
| overhead ratio | **53.4%** (234,215 units) | **5.2%** (11,239 units) | unknown (no cost receipts) |
| room events | **13,260 → INFEASIBLE** | 3,060, feasible | **0** (by design) |
| dominant cost | burst_contention (49%) | room_events | spawn-plane contention/failures |

**Where the model was RIGHT:**

- *Lever direction.* The wave independently converged on all three levers —
  batched dispatch (launcher spawns in batches), standing claims (static
  guild partitions, one claim per guild), digest (ledger + DONE rollup
  instead of per-worker reports) — and pushed past the model's floor to
  zero room events. The model's ranking (batch ≫ others) matches
  observation: spawn-plane contention, not room chatter, was the binding
  constraint (the plane went critical; the room stayed silent).
- *The event ceiling as the naive binding constraint.* At N=2040 naive the
  model says 13,260 events → infeasible; the wave's zero-event design is
  consistent with that bound biting.
- *Contention dominance at scale.* The model says the burst term is 49% of
  naive overhead at N=2040. Observed: spawn contention/failures dominated
  coordination cost (cadence collapse, pauses, respawns).

**Where the model was WRONG or incomplete:**

1. *No zero-room-event regime.* Model floor is 3,060 events (all levers);
   the wave runs at 0 via ledger-file coordination. The model undercounts
   what's achievable — and has no term for the cost that replaced room
   events (ledger append/parse, coordinator read time).
2. *Smooth burst curve vs failure cliff.* The model predicts per-spawn cost
   scaling as W^0.71 (smooth, ×~8.5 at N=2040 width). Observed: the plane
   sustains ≤4 parallel, then lock timeouts → 50–75% success → "Broken
   pipe"/90 s timeouts → full pause. Overhead is **failure-driven**
   (retries, respawns, pauses), not latency-driven. Effective per-spawn
   20–300 s vs the 1.15 s fork analog — two orders of magnitude, and the
   shape is a cliff, not a bend.
3. *Topology.* The model assumes per-coordinator fan-out (width = batch
   count). Reality: centralized launcher spawn (depth constraint, §7.1) —
   one spawner, one point of contention and failure. Unmodeled.
4. *Calibration anchors.* `burst_exponent` 0.71 came from fork() at widths
   3→8; `dispatch_fixed` 7.5 units and `event_cost` 2 are calibrated, not
   measured; `calibration_N=100` was never tagged to a real wave. The
   wave-2000 spawn data (widths 1–4, failure-dominated) does not confirm
   the exponent — it suggests the exponent is the wrong functional form
   past the capacity cliff.

## 9. Refined model (v2 adjustments, for the model owners)

1. **Regime L — ledger/file-based coordination:** `room_events = 0`; add
   `ledger_append × heartbeats + ledger_parse × readers` terms
   (provenance: UNCALIBRATED — wave-2000 gives event counts, not costs).
2. **Capacity+failure spawn model** replacing smooth `burst_contention`
   past the cliff: `E[cost] = attempts(W)/success_rate(W) × per_attempt`
   with measured `W_cap ≈ 4` on this plane; `success_rate` 1.0 → 0.5–0.75
   → 0 across the cliff; plus a respawn term (11/250 ≈ 4.4% drain-kill
   rate observed once — single sample, do not generalize).
3. **Centralized-spawn topology flag:** one spawner ⇒ contention and
   failure correlate across all guilds; a plane pause stalls the wave
   (observed 45-min ledger-time pause).
4. **`events_per_lifecycle = 0` is attainable** (ledger regime), with the
   cost moved off-room — model it, don't ignore it.
5. **Measurement hazard:** validate agent-written timestamps against
   filesystem mtime; report skew (observed ~80 min, unstable).

## 10. Integration dependencies

- `~/workspace/pr-wave2000/launcher-ledger.md` — live wave record (grows
  during the wave; read 2026-10-09 ~12:42 PDT real)
- `~/workspace/goals/autonomous-work-engine-never-stop/hidden_files/loop-state/claims.json`
  — claim registry (17 wave2000 claims scanned 2026-10-09)
- `git ls-remote origin 'refs/heads/wave2000/guild-*'` — captured
  2026-10-09 to `scratch/refs-wave2000.txt` (7 branches)
- Model: `origin/wave500/coord-cost` @ `df9dab52d532`,
  `scripts/overhead-model.mjs` (N=2040 evaluated on a scratch copy)
- Presence/streaming: `origin/wave500/presence` @ `e3b1b4aca`
  (delta-board 794.9× steady-state; SSE pre-F1 baseline — read, not rerun)
- Room API: `GET /api/rooms/muse-room/events` → 401 unauthenticated
  (no identity minted, per no-credentials rule)

## 11. What is NOT proven

- Token/compute cost of the wave (no receipts; the field stays `unknown`).
- Per-worker queue-wait distribution (only guild-level phase lower bounds).
- Review/integration latency for worker-phase guilds (zero DONE samples).
- Push counts and push times per branch (refs show tips only).
- Whether the ~80-min ledger clock skew is constant (deltas assume it).
- Absolute wall-clock durations in real time (all ledger times suspect).
- That zero room events generalizes (this wave's design choice under a
  ~78%-used room byte budget, per ledger).
- Any conversion between model "units" and dollars/tokens (never established).
- Runnable counts beyond the launcher's own approximate heartbeats.
- Whether the 4.4% drain-kill rate or the W_cap≈4 cliff holds on another day
  (single-wave, single-plane observations).

## 12. Reproduce

```sh
cd ~/workspace/pr-coord300-guild-02          # branch coord300/guild-02
TMPDIR=$PWD/.tmp node --test tests/coord300-wave-accounting.test.js
TMPDIR=$PWD/.tmp node scripts/measure-wave-overhead.mjs --live
# negative control is a test, not a flag:
# tests/fixtures/coord300/ledger-poisoned.md must raise duplicate/anomaly flags
```

## 13. Presence-branch notes (read, per brief)

`wave500/presence` @ `e3b1b4aca`: delta-board benchmark shows 794.9×
steady-state poll reduction (248.4 KB → 0.3 KB); the SSE scale bench is a
pre-F1 SIM baseline of the per-stream pump (not rerun here — no load
generation per Dot). Relevance to wave-2000: the wave's 290 live agents
hold **zero** room SSE connections (no room presence load at all), which is
consistent with the zero-event design — presence cost is avoided entirely,
not optimized.
