# E2E Trial — Batched vs Control Dispatch (WAVE-500 coord-cost, worker 17/17)

**Status:** executed 2026-10-08. 3 full runs, 5+5 workers per run.
**Branch:** `wave500/coord-cost` · head `c34b938a` (at trial time).
**Harness:** `scripts/e2e-trial.mjs` (driver) + `scripts/e2e-worker.mjs`
(synthetic worker). Re-run: `node scripts/e2e-trial.mjs --run-dir <dir>
--turn-handshake-ms 2000 --work-ms 400`. Self-test:
`node scripts/e2e-trial.mjs --run-dir <dir> --self-test`.

## 1. Design

Two arms, identical synthetic tasks, one shared context:

- **CONTROL (traditional):** 5 sequential coordinator turns. Each turn
  re-embeds the full shared context (8,322 B) into the worker's brief, spawns
  the worker, waits, reads a free-text DONE report (~700 B, modeled on real
  room DONE blocks), and parses it with `scripts/normalize-report.mjs`
  into a normalized receipt.
- **TREATMENT (batched):** one batch manifest validated by
  `scripts/batch-dispatch.mjs` (batch `batch-23f8d4fd4aa7`): shared context
  sent **once** + content-addressed `contextRef`; each worker gets a delta
  brief + ref pointer. 5 workers fan out **concurrently**, each emits a
  structured v1 receipt (`docs/RECEIPT-SCHEMA.md`), validated by
  `scripts/validate-receipt.mjs` and rolled into one batch receipt.

The 5 tasks (identical both arms) are small deterministic analyses over a
fixture corpus: receipt-schema audit, file fingerprinting, heading harvest,
size profile, claim-id extraction. Task duration is fixed at 400 ms of real
busy work per worker, identical across arms — the trial measures
*coordination overhead*, not task work.

**What a subagent cannot measure:** I cannot spawn real LLM workers, so
workers are deterministic node child processes. Measured quantities are
coordinator-side **bytes** and coordinator-side **read/parse/fan-in timings**.
Turn-structure wall-clock (5 sequential turns vs 1 batch turn) uses an
explicitly-labeled per-turn handshake latency, default 2000 ms
(`--turn-handshake-ms`). Worker 3's `docs/SPAWN-LATENCY.md` landed
*mid-trial* and measures the real per-spawn fixed latency at ~0.94–1.30 s on
this host (median ~1.15 s) — so the default is within 2× of measured, and
§3 includes a row anchored on the measured value. Sensitivity to the
assumption is reported in §3 — read it before citing any wall-clock number.

Coordination note: the live claims board (#266) was read before starting —
no lane holds this task. A CLAIM post failed: GitHub locked #266 at the
2500-comment limit (HTTP 403), so the board is currently read-only for
comments. First-claim-wins was honored via the read; no collision found.

## 2. Measurements (median of 3 runs; bytes deterministic across runs)

Shared context: **8,322 bytes** (wave goal + conventions + real
`docs/WORK-CLAIMS.md` head + real file map).

| Metric (median, 3 runs) | Control | Treatment | Δ |
|---|---|---|---|
| Dispatch bytes (coordinator → workers) | 43,442 B (5 × ~8,688 B, shared re-sent 5×) | 12,116 B envelope (shared once 8,322 B + 5 deltas 1,832 B + framing) | **−31,326 B (−72.1%)** |
| Report bytes (workers → coordinator) | 3,530 B free text | 2,319 B v1 receipts | **−1,211 B (−34.3%)** |
| Fan-in: parse/validate+aggregate | 4,407 ms (normalize-report ×5) | 4,288 ms (validate-receipt ×5 + batch rollup) | wash (−2.7%, noise) |
| Parse quality | 5/5 reports left `openQuestions` low-confidence (coordinator must eyeball) | **5/5 receipts VALID, 0 human-eyeball fields** | structured win |
| Wall-clock, dispatch → last receipt parsed | 21,955 ms | 9,604 ms | **−56.3%** (see §3) |

Cross-checks against sibling work:

- `batch-dispatch.mjs`'s own token model on this manifest: independent
  10,833t vs batched 2,593t → **−76.1%** context tokens — within 4 points of
  our measured −72.1% byte delta. Two independent computations agree.
- `docs/RECEIPT-SCHEMA.md`'s compression demos on 5 *real* room reports:
  median **−35%** bytes (excluding the already-terse D1). Our synthetic
  −34.3% lands in the same band — the receipt size win is not an artifact
  of my terse templates.

## 3. Wall-clock decomposition and the handshake assumption

Median wall-clock decomposition (handshake = 2000 ms/turn, ASSUMED):

| Component | Control (5 turns) | Treatment (1 turn) |
|---|---|---|
| Coordinator turn handshakes (ASSUMED) | 10,000 ms | 2,000 ms |
| Worker spawn + task work (400 ms each) | 7,294 ms (serial) | 2,272 ms (parallel) |
| Coordinator parse / validate + aggregate | 4,407 ms | 4,288 ms |
| Brief/envelope assembly | 9 ms | 872 ms |
| **Total** | **21,955 ms** | **9,604 ms** |

The assumed handshake is 8,000 of the 12,351 ms saving. Sensitivity:

| Handshake/turn | Control wall | Treatment wall | Δ | Provenance |
|---|---|---|---|---|
| 0 ms (pure local measurement) | ~11,955 ms | ~7,604 ms | −36.4% | measured |
| 1,150 ms (median per-spawn latency) | ~17,705 ms | ~8,754 ms | **−50.6%** | measured (docs/SPAWN-LATENCY.md) |
| 2,000 ms (default) | 21,955 ms | 9,604 ms | −56.3% | assumed |
| 5,000 ms | ~36,955 ms | ~14,604 ms | −60.5% | assumed |

The remaining −36% at handshake=0 is real and structural: parallel fan-out
vs serial spawns, and the −72% dispatch-byte / −34% report-byte savings that
an LLM coordinator pays in tokens and attention. The local fan-in *CPU*
cost is a wash (both arms are dominated by node process startup, ~500 ms per
invocation) — on a real coordinator the fan-in cost is reading, not CPU, and
that is exactly where bytes + machine-checkability bite.

## 4. Threats to validity

1. **Synthetic workers (top threat).** Node processes do not replicate an
   LLM worker's read/parse cost: a real coordinator pays tokens and
   attention per byte, which is precisely what the byte deltas proxy — but
   the *measured* fan-in ms here is local CPU, not coordinator cognition.
   Treat byte deltas as the transferable result; treat wall-clock as
   structure + assumption, per §3.
2. **Cooperative control reports.** My free-text template always includes
   labeled `status:`/`workerId:`/`tests:` lines. Real room reports are
   noisier (multi-signal statuses, unlabeled fields), which would make
   control parse quality *worse* than measured here — the treatment
   advantage is likely understated, not overstated.
3. **Assumed handshake.** The dominant wall-clock term is a parameter —
   but worker 3's `docs/SPAWN-LATENCY.md` (landed mid-trial) independently
   measures per-spawn fixed latency at ~0.94–1.30 s on this host, and the
   sensitivity table's measured row (−50.6% at 1,150 ms/turn) now anchors
   the claim. Absolute ms remain VM-specific; the ratio is the portable part.
4. **Shared noisy box.** Validate-exec timings swung 449–1537 ms across
   invocations (hundreds of agents share this VM). Hence 3 runs + medians;
   byte figures are deterministic and unaffected.
5. **N=5, single wave, one run context.** The batch spec caps at 100
   workers/batch; the savings model (§8 of the spec) says gains grow
   linearly with N. This trial does not test N=50 or failure injection
   (one worker erroring) — both are the natural next trial.
6. **Mid-trial tool drift.** A sibling lane updated `normalize-report.mjs`
   (status vocabulary `done` → v1 `completed`) while the trial was being
   built; caught by the driver's `--self-test`. The branch is concurrently
   edited — always re-verify before committing (see §5).

## 5. Conclusion

The tooling reduces coordination overhead on every measured axis that
transfers to a real coordinator:

- **−72.1% dispatch bytes** (43,442 → 12,116 B), cross-validated by the
  spec's own −76.1% token estimate — the batch manifest's shared-context
  factoring works as designed.
- **−34.3% report bytes** (3,530 → 2,319 B), matching the −35% median on
  real reports in `RECEIPT-SCHEMA.md` — structured receipts are
  meaningfully smaller than free-text DONE blocks.
- **Parse quality:** 5/5 treatment receipts machine-validated with zero
  eyeball fields vs 5/5 control reports leaving `openQuestions`
  low-confidence — the fan-in stops being a reading task.
- **Wall-clock:** −36% measured-structural (parallel fan-out + smaller
  payloads), rising to −56% with a 2 s/turn handshake assumption; the
  assumption is bounded in §3, not hidden.

Net: batch dispatch + structured receipts are worth adopting for wave
dispatch. The honest caveat is that the biggest wall-clock term is the
turn structure itself — now anchored at −50.6% by worker 3's measured
~1.15 s/spawn latency (§3), up from the −36% that is purely structural.
Absolute ms remain host-specific; the ratio and the byte deltas are the
portable results.

## 6. Reproducing

```sh
# smoke (one worker per arm + manifest validation)
node scripts/e2e-trial.mjs --run-dir /tmp/e2e-smoke --self-test
# full trial (3 runs for medians, TMPDIR worktree-local per repo rules)
for i in 1 2 3; do
  TMPDIR=$PWD/.e2e-tmp node scripts/e2e-trial.mjs \
    --run-dir $PWD/.e2e-tmp/run$i --turn-handshake-ms 2000 --work-ms 400
done
```

Suggested next trial: N=50 with one injected worker error, to measure the
batch failure-isolation path (per-worker `error` entries in the batch
receipt) against control's serial error handling.
