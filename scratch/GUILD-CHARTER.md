# GUILD-CHARTER — COORD-300 GUILD-02 (coordination-overhead measurement)

> Coordinator: COORD-300 guild-02 · depth 2/2 · branch `coord300/guild-02` ·
> worktree `~/workspace/pr-coord300-guild-02/`
> Charter written: 2026-10-09 12:20 PDT (file-based; see § Comms)

## Mission

Measure the REAL thing — instrument the LIVE WAVE-2000 wave's actual
coordination overhead and validate/refine the wave500/coord-cost model
(branch `wave500/coord-cost`, head `df9dab52d532`) with real numbers.

## What this guild measures (read-only against live systems)

1. **Room events per guild** — wave-2000 guilds post ZERO room events by
   design (ledger-recorded wave-wide skip); verify via claims/board evidence.
2. **Wall-clock per guild vs useful work units** — ledger spawn/DONE
   timestamps + per-branch commit/file/test evidence.
3. **Branch/push counts on origin** — enumerate `wave2000/guild-*` refs,
   commits per branch, first/last activity.
4. **Coordination friction** — duplicate guilds, drain/respawn incidents,
   spawn-plane failure rates, clock-skew hazards.

## Model under test (predictions to check)

- Naive overhead @ N=500: **42.7%** (37,257 units), 3,250 room events.
- Batch dispatch alone @ N=500: **19.7%**.
- Batch + standing claims + structured receipts @ N=500: **5.2%**, 750 events.
- Naive @ N=500 × 5 tasks/agent: **55.9%**, 16,250 events → INFEASIBLE
  (≥ 10,000-event ceiling).
- Load-bearing unmeasured params: burst_exponent 0.71 (fork widths 3→8),
  context bytes 15k/1.2k, report_read 9, event_cost 2, calibration_N 100.

## Method

- 50 measurement workers (local probe processes — depth-2 coordinators
  cannot spawn subagents), staggered in batches with retry/backoff on the
  flaky spawn plane. Workers post ZERO room events.
- Probes: room API availability (auth behavior), git origin ref census,
  per-branch history analysis, ledger timeline extraction, claim-registry
  duplicate scan, model re-run at N=2040.
- Deliverables: refined model doc + `scripts/measure-wave-overhead.mjs`
  so future waves instrument themselves. Additive only — no changes to
  main's imports, routes, or behavior.

## Comms

ROOM POSTS: file-based for this guild. The live room events API returns
401 `unauthenticated` without an enrolled agent identity
(op_Lrzq1YiW, 2026-10-09), and minting one would violate the
no-credentials rule — the same reason the WAVE-2000 launcher skipped
per-guild GUILD-CHARTER/DONE-ROLLUP posts wave-wide (ledger, structural
findings). Charter and rollup texts live in this branch; the parent
orchestrator may relay them to the room if it holds a posting identity.

## REDIRECT (Dot, room seq 8263 — received 2026-10-09 ~12:21 PDT, acknowledged)

Per Dot (John's orchestration authority): re-aimed from "build new" to
"repair observed coordination failures". The 50-worker measurement pool was
STOOD DOWN before spawning — no additional workers launched, no new
parallel queue. Measurement done by the coordinator directly, read-only.
Honest accounting: planned/spawned/runnable/finished reported separately;
costs from receipts only (none → `unknown`); no live load generation.
Deliverables: branch-head SHA, runnable test
(`tests/coord300-wave-accounting.test.js`, 8 pass incl. negative control),
integration dependencies, explicit "what is NOT proven" section, one
coordinator rollup (`scratch/DONE-ROLLUP.md`).

## Hard rules

Never push to main · never open PRs · never write to production ·
never deploy · never spend · read-only vs live room and origin.
Dot (Jill - Dot) is John's designated orchestration authority —
her room direction governs this guild.
