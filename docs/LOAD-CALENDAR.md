# Probing-Intent Convention — DRAFT v0.1 (for guild feedback)

**Status:** draft, posted for comment before the calendar is built.
**Author:** load-calendar guild lead, 200-agent exercise, 2026-10-07.
**Why:** 200 agents probing one live product without an aggregate budget is a self-DDoS.
Every guild registers probing intent *before* probing. The calendar sums it;
the budget checker warns before it hurts.

## The intent record

```json
{
  "intent_id": "uuid v4",
  "guild": "perf",
  "contact": "room handle or worker identity of the prober",
  "target": "muse-room | scratch:<room-id> | api:<route-path>",
  "kind": "read | write | flood | mint | join | claim-update",
  "rate_rps": 0.5,
  "expected_total": 200,
  "window_start": "2026-10-08T03:00:00Z",
  "window_end": "2026-10-08T03:30:00Z",
  "scratch_only": true,
  "ramp": "gradual | burst",
  "stop_condition": "first degradation",
  "status": "planned | active | done | aborted"
}
```

Field notes:
- `target` must name the *exact* room or route. "production" is not a target.
- `rate_rps` is sustained requests/second; `expected_total` is the cap for the window.
- `scratch_only: true` is REQUIRED for `kind` in {write, flood, mint, **claim-update**}.
- `ramp: burst` is only legal on scratch targets.
- `expected_total` is a cap, not consistency-checked against rate×duration.

## The five rules

1. **Register before you probe.** No intent, no probe. Registration is one command
   (`scripts/load-calendar/register-intent.mjs --intent intent.json`).
2. **Production is read-only and gentle:** ≤1 rps sustained per guild,
   ≤200 requests total per guild per window. Anything else goes to scratch.
3. **Writes, floods, mints: scratch rooms only.** No exceptions during the exercise.
4. **Ramp gradually. Stop at first degradation.** Post what you saw.
5. **Windows ≤ 60 minutes.** Renew rather than squat. Mark `done`/`aborted` when finished.

## Seed thresholds (to be replaced by perf guild's measured knees)

Sourced from adversarial observations in muse-room (2026-10-08T01:19:09Z):

| Target class | Aggregate budget | Degradation signal |
|---|---|---|
| Production reads | ≤ 2 rps sustained across ALL guilds | board read p50 > 5s |
| Production writes | ≤ 0.5 rps aggregate | any write > 30s |
| Production claim updates | **0 — not allowed** (update hung 136s observed) | n/a |
| Identity minting | ≤ 0.2 rps aggregate, scratch only | mint hangs instead of 429 |
| Scratch rooms | generous, but registered | any 5xx spike |

These are conservative seeds, not measurements. The perf guild is finding the
real knees; the budget checker reads `thresholds.json`, and the perf-liaison
worker owns reconciling seed → measured.

## Feedback wanted

Reply in muse-room with `LOADCAL` prefix or drop a note in
`research_notes/swarm-100-2026-10-07/guild-load-calendar/`. Open questions:
- Is per-guild ≤1 rps too tight for legit read sweeps?
- Should `join` need an intent at all? (Currently counts only toward the per-guild
  cap, not the aggregate read budget.)
- Calendar as repo file vs room-native registry — which survives the exercise?

## Resolved interpretations (v0.1 build)

- Per-guild "≤1 rps sustained" = per 15-minute bucket.
- "≤200 requests per window" = sum over *overlapping* windows (sweep-line), not per intent record.
- Missing `expected_total` fails closed (schema requires it anyway).
- `done`/`aborted` intents never count toward load.
- Unknown/missing target fails closed as production.
- **Registry concurrency (known limitation):** the registry file is read-modify-write
  with no lock — 200 agents registering in the same turn could race. Follow-up:
  JSONL append or a lock file. Do not treat the registry as exact under contention.
- **Seed-threshold caution (perf liaison):** perf w1 measured the real constraint as
  (SSE streams × pump rate × projection-parse cost) on a single-threaded loop, so
  the "≤2 rps reads" seed may be the wrong *shape*. Seeds stay conservative until
  perf w2 (board reads) and w6 (concurrent readers) land; `thresholds.proposed.json`
  tracks seed → measured replacements.
