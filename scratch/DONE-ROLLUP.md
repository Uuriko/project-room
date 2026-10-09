# DONE-ROLLUP — COORD-300 GUILD-02 (coordination-overhead measurement)

**Branch head:** `9ef54afe2a9cf7081a7347a37a7b720ef393aede` (pushed to origin)
**Branch:** `coord300/guild-02` · **Worktree:** `~/workspace/pr-coord300-guild-02/`
**Rollup written:** 2026-10-09 ~12:50 PDT real (ledger clock ~80 min fast — see caveat)

## Redirect acknowledgment

Dot (room seq 8263, John's orchestration authority) redirected this guild
mid-flight from "build new" to "repair observed coordination failures."
The 50-worker measurement pool was **stood down before spawning** — no
additional workers, no new parallel queue, no live load generation, no
board/protocol/permission changes. All measurement done by the coordinator
directly, read-only, offline/fixture-backed. Acknowledged in charter
(`scratch/GUILD-CHARTER.md`) and here.

## What was delivered (all on the branch, additive only)

- `docs/COORD300-WAVE2000-MEASUREMENT.md` — full measurement report
- `scripts/measure-wave-overhead.mjs` — runnable accounting
  (`--live` for real inputs; offline fixtures by default)
- `tests/coord300-wave-accounting.test.js` — **8/8 pass**, incl. negative
  control (poisoned fixture raises duplicate/anomaly flags, never silently
  counts; costs stay `unknown`)
- `tests/fixtures/coord300/{ledger-clean,ledger-poisoned}.md`
- `scratch/` — charter (+redirect ack), ref census, live accounting output,
  N=2040 model evaluation
- No PR opened (per hard rules). No main push. No room posts (see below).

## Measured numbers vs model predictions

Model = wave500/coord-cost @ `df9dab52d532`, its own script at N=2040.
Actual = WAVE-2000 live wave (ledger + claim registry + origin refs,
read 2026-10-09 ~12:42 PDT real).

| | Model naive | Model all-levers | Actual |
|---|---|---|---|
| overhead ratio | 53.4% | 5.2% | **unknown** (no cost receipts) |
| room events | 13,260 → INFEASIBLE | 3,060 | **0** (by design) |
| dominant cost | burst_contention (49%) | room_events | spawn-plane contention/failures |

Four counts: **planned 2040** · **spawned 40 coords + 250 workers (unique)**
· **runnable ~290** (launcher heartbeat, approximate) · **finished: 1
timestamped DONE (guild 29) + 3 prose-reported (22, 26, 31)**.
Duplicates: 0 (17 wave2000 claims, 7 origin branches, no dupes).
Drain: 11 killed, all respawned. Branches on origin: 7/40 — guild 29 is
DONE with **no origin branch** (push gap).
Queue (ledger-time lower bounds): G01 ≥35 min, G04 ≥35 min, G05 ≥100 min
(incl. 45-min plane pause); G02/G03 starts unobserved. Effective per-spawn:
20–300 s under contention vs the model's 1.15 s fork analog.
Review latency: unknown (zero worker-phase DONE samples; one ~16-min
coordinator-only data point).

## Where the model was right / wrong

RIGHT: lever direction (the wave independently built batch + standing +
digest and went further to 0 events); the event ceiling biting at scale;
contention — not chatter — as the binding cost.
WRONG/MISSING: no zero-room-event regime (floor was 3,060; actual 0);
smooth W^0.71 burst curve vs the observed **failure cliff** (≤4 parallel,
then lock timeouts → 50–75% success → "Broken pipe"/90 s timeouts →
full pause); centralized launcher spawn topology (depth-2 coordinators
can't spawn — unmodeled); per-spawn cost off by ~2 orders of magnitude.

## Caveats (see §11 of the measurement doc for the full list)

- Ledger clock runs **~80 min fast** (unstable across samples: 64→80 min);
  absolute times unusable, deltas assume constant skew (unproven).
- Costs unknown; per-worker queue distribution unknown; push counts/times
  unknown (refs show tips only); model "units" have no dollar/token conversion.
- Room posts: **not posted** — events API returns 401 without an enrolled
  identity (`op_Lrzq1YiW`); minting one violates the no-credentials rule
  (same reason the WAVE-2000 launcher skipped guild posts wave-wide).
  Charter + this rollup live on the branch for the parent to relay if it
  holds a posting identity.

## Claim

`coord300-guild-02` held by `coord300-guild-02-coordinator` (read back
via claim.sh). Work complete; claim may be released by the parent.
