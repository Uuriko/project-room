# PARTITION-VALIDATION — historical validation of partition tooling

Worker: wave500-coord-cost-worker16 (coord-cost lane, WAVE-500)
Date: 2026-10-08/09 (Thu ~19:00–20:05 PDT)
Claim: `wave500-coord-cost-partition-validation` via claim.sh (first-claim-wins; no sibling lane owned validation)

## Tooling under test

- `scripts/partition-check.mjs` — PRESENT (untracked, owned by wave500-coord-cost-worker10; not committed by this worker). Overlap gate across four axes: (a) file/dir incl. dir-prefix containment, (b) branch-name equality, (c) claim-id namespace, (d) worktree nesting. Exit 0=PASS, 1=FAIL, 2=input error. Its own unit suite: **4/4 pass** (`node scripts/partition-check.test.mjs`, 2026-10-08).
- `scripts/partition-plan.mjs` — PRESENT as of mid-validation (landed by wave500-coord-cost-worker9 while this validation ran; untracked, owned by worker9, not committed here). Static partition planner: greedy graph-coloring on the file/dir conflict graph + must-link closure + balanced bin-packing into K partitions, with per-partition claim namespaces, execution waves, determinism, and honest imbalance reporting. Experiment (c) below runs the REAL planner. (Early in this run the file was absent; the doc first drafted a manual-assignment stand-in — superseded.)
- NOTE on commit hygiene: my `git add docs/partition-validation/` swept in two files worker9 wrote concurrently (`wave300-10lanes-plan.json`, `wave300-10lanes-check-input.json` — their planner run over my wave300 input). They ride along in my commit 0085168f; attributed to worker9 here.

Method for all experiments: run the real `scripts/partition-check.mjs` against JSON partitions; raw tool output saved under `docs/partition-validation/*.check.txt` (transcribed verbatim below).

---

## Experiment (a) — WAVE-300 ten-lane partition, real branch/worktree/file data

**Verdict: checker FAILS — 32 overlap(s) across 10 partitions (45 pairs).**
Full output: `docs/partition-validation/wave300-10lanes.worker16.check.txt` (worker-16-owned evidence file; the sibling-shared `wave300-10lanes.check.txt` was overwritten by another lane's planner run mid-validation — see caveats).

NOTE on live-data drift: the first run (19:30 PDT) reported 31 overlaps; a re-run at ~23:35 PDT reported 32 — the payloads lane added `server/store.mjs` in between (new `fanout × payloads` flag). The lanes are still live, so counts move; the contention pattern is unchanged.

### Reconstruction method
- 8 of 10 lanes verified against live data: branch names read from the actual lane checkouts (e.g. `pr-wave300-backpressure` → `wave300/honest-backpressure`, `pr-wave300-fanout` → `wave300-fanout-perf`, `pr-wave300-payloads` → `wave300/payload-store`, `pr-wave300-replay` → `wave300/replay-harness`; `wave300/data-plane-fastpath`, `wave300/sharded-claim-boards`, `wave300/telemetry-prod`, `guild-claimsboard/lease-first-reaper` verified as origin refs); file sets = `git diff --name-only` of each branch vs its own origin/main merge-base (read-only, never touched the lane repos).
- 2 lanes (`wave300/stranger-qa`, `wave300/burn-down`) have no surviving branch or worktree: reconstructed with topic-derived placeholder file sets, clearly marked in `_provenance`. Verdicts on the 8 pairs involving them are **unvalidated** (see false-positive FP-1).
- Claim IDs were synthesized (`wave300-<lane>-01`); the historical per-lane claim IDs are not recoverable, so the claim-id axis verdict is weak by construction. All branch names, worktrees, and 8/10 file sets are real.

### The 32 overlaps (by file)
| file | pairs hit | count |
|---|---|---|
| `docs/openapi.yaml` | dp×bp, dp×fan, dp×shards, dp×pay, bp×fan, bp×shards, bp×pay, fan×shards, fan×pay, shards×pay | 10 |
| `server/http.mjs` | bp×fan, bp×shards, bp×pay, bp×tel, fan×shards, fan×pay, fan×tel, shards×pay, shards×tel, pay×tel | 10 |
| `server/work-claim-routes.mjs` | dp×fan, dp×shards, fan×shards | 3 |
| `server/work-claim-sqlite.mjs` | reaper×fan, reaper×shards, fan×shards | 3 |
| `scripts/runtime-package.mjs` | reaper×pay, reaper×tel, pay×tel | 3 |
| `server/work-claims.mjs` | reaper×shards | 1 |
| `server/mcp-full-profile.mjs` | dp×fan | 1 |
| `server/store.mjs` | fan×pay | 1 (appeared in re-run ~23:35 PDT — live lane added it; see drift note) |

(lane abbreviations: dp=data-plane, bp=backpressure, fan=fanout, shards, pay=payloads, tel=telemetry, reaper=guild-claimsboard/lease-first-reaper)

### Analysis
- **No branch-name, claim-id, or worktree overlaps** — the partition was clean on identity axes (distinct branches/worktrees/claim namespaces), which is what the wave-300 coordination actually managed.
- **Shared-hub files dominate the failures.** `docs/openapi.yaml` (regenerated contract doc), `server/http.mjs` (module import hub), `scripts/runtime-package.mjs` (exact allowlist — every new `server/*.mjs` must register) are *registry artifacts*: every lane must touch them, by design. The checker is correct per its file-granularity contract — two writers on one file is a real collision risk — but it cannot see line-level disjointness (different OpenAPI sections, different import lines). These 23 flags are **true-by-contract but operationally noisy**: the useful signal is "these files need a serialization protocol" (append-only regen, union-check on the allowlist), which is exactly what the lane conventions grew (cf. AGENTS.md lessons on the runtime-package count assertion and openapi regen).
- **Claim-system core files are the real contention.** `server/work-claim-routes.mjs`, `server/work-claim-sqlite.mjs`, `server/work-claims.mjs` (7 flags) are the subsystem the reaper/shards/fanout/data-plane lanes were all redesigning concurrently — genuine same-subsystem overlap, the class of collision that historically produced rebase conflicts and superseded PRs (see experiment b). On the intended use ("run the gate pre-wave"), these are the flags a coordinator should act on: narrow the lanes or sequence them.

**Net: the checker did not rubber-stamp history — it surfaced exactly the shared-registry + shared-subsystem contention the wave-300 postmortems describe. PASS-on-paper would have been the suspicious outcome.**

---

## Experiment (b) — KNOWN historical collision: recoverable-mint 500 double-fix

**Verdict: checker FAILS — 1 overlap, flagging the exact collision file. TRUE POSITIVE.**
Full output: `docs/partition-validation/qa2-collision.check.txt`

Reconstruction (both from real commit data):
- `qa2-signed-in-agent`: branch `jill/qa2-recoverable-mint-500-fix`, worktree `~/workspace/pr-qa2-signed-in-agent`, files from merged PR #1436 (merge 218205d5, 2026-10-04 11:17 PDT): `server/agent-identities.mjs`, `tests/agent-identities.test.js`.
- `qa2-contract`: branch `qa2-contract/c-identity-retry-500`, worktree `~/workspace/pr-qa2-contract`, files from the superseded fix commit 34aac85d (2026-10-04): `server/agent-identities.mjs`, `tests/agent-identity-recoverable-own-credential.test.js`.

Tool output:
```
FAIL — 1 overlap(s) across 2 partitions:
  [file/dir] qa2-signed-in-agent × qa2-contract: "server/agent-identities.mjs" ↔ "server/agent-identities.mjs"
```
History agrees: both lanes independently fixed the identical recoverable-mint 500 (#1436 merged, #1443 closed superseded; one worker-cycle discarded — AGENTS.md Workflow law II). The checker flags the shared file — the one whose line-level edit conflict the fix-dedup protocol was invented to prevent. **The gate would have caught this collision before the second fix started.**

No false positives in this pair: the two test files are disjoint (both kept — the suites differ), and the flag is on the single file both lanes actually edited.

---

## Experiment (c) — synthetic 40+ task list through the REAL planner, checker verifies output

**Verdict: planner co-locates every injected conflict; independent checker PASS (exit 0), zero overlaps across 8 partitions.**
Assets: `swarm40-tasks.json` (input), `swarm40-plan.json` (planner output), `swarm40-plan.stdout.txt`, `swarm40-plan.check-input.json`, `swarm40-plan.check.txt`.

- Input: 48 synthetic tasks (40 base across 8 wave-style lane topics × 5, plus 8 injected conflict tasks) modeled on the swarm-100 exercise pattern.
- Injected conflicts: `server/http.mjs` shared by a backpressure + a telemetry task; `docs/openapi.yaml` shared by a data-plane + a fanout task; `server/work-claim-sqlite.mjs` shared by a reaper + a shards task; `server/payload-store.mjs` shared by two payloads tasks.
- Planner run: `node scripts/partition-plan.mjs --tasks swarm40-tasks.json --partitions 8 --prefix synth --out swarm40-plan.json --json`.
- **Co-location: every injected cross-lane conflict pair landed in the SAME partition** (`bp-http-reg`+`tl-http-reg` → synth-p0; `dp-openapi`+`fo-openapi` → synth-p1; `pa-store-a`+`pa-store-b` → synth-p2; `rp-claims-sql`+`sh-claims-sql` → synth-p3) — the must-link closure behaving as documented.
- **Determinism: two identical runs → byte-identical plans.**
- Planner exit code was **1, not 0**: the indivisible conflict components (each lane's tasks share its `docs/<lane>/` dir, forming one atom per lane) make ±1 balance impossible (sizes 7,7,7,7,5,5,5,5); the planner reports the residual imbalance honestly instead of hiding it. This is the correct behavior for a coordinator gate — flag, don't fake.
- Checker, run independently on the planner's emitted partitions (converted to partitions JSON): **`PASS — 8 partitions, zero overlaps`** — the checker's own recomputation agrees with the planner's internal `crossPartitionOverlaps: []`.

A preliminary manual disjoint assignment (stand-in from before the planner landed) also passed the checker, and a negative control — one shared file injected into two lanes of an otherwise-disjoint plan — fails the checker on exactly that file (`swarm40-negative-control.check.txt`): the gate is not vacuously passing.

**Net: planner → checker compose correctly. The planner's guarantee (conflicting tasks never separated) is independently confirmed by the checker, and its honesty property (exit 1 on residual imbalance) held.**

---

## False positives / negatives / caveats

1. **FP-1 (reconstructed lanes):** `wave300/stranger-qa` and `wave300/burn-down` file sets are topic-derived placeholders. Zero-overlap verdicts on the 8 pairs touching them say nothing about history.
2. **FP-2 (file granularity):** registry artifacts (`openapi.yaml`, `http.mjs`, `runtime-package.mjs`) will always flag when lanes behave correctly. Consider an allowlist-with-protocol for known registry files, or section/line-range scoping, to keep the gate signal-to-noise usable at 45+ pairs.
3. **FP-3 (merge-base drift):** lane file sets were computed against each lane repo's own `origin/main`, which sit at different main SHAs. Files merged to main between a lane's base and now may be misattributed.
4. **FN-1 (claim-id axis):** historical wave-300 claim IDs unrecoverable; synthesized IDs prove only that the axis *runs*, not that history was clean on it.
5. **FN-2 (what the checker can't see):** same-file different-line edits (the `#1436`/`#1443` class: same file, overlapping *hunks*) vs same-file disjoint edits — the checker treats both identically. It is a collision *gate*, not a merge oracle. Conversely, it misses cross-file semantic coupling (e.g. lane A changes an API that lane B's untouched file consumes).
6. **Coverage note:** the replay lane had three sub-worktrees (replay-w1/w2/w3); only the harness branch was modeled as the lane partition. Sub-partition overlap inside a lane is out of scope for the lane-level gate.
7. **Planner honesty, confirmed:** exit 1 on residual imbalance (sizes 7,7,7,7,5,5,5,5 vs 8×6) is a feature, not a bug — indivisible conflict atoms are reported, not silently split. A coordinator consuming exit codes must treat 1 as "review," not "broken."
9. **Shared-dir evidence hazard (observed live):** `docs/partition-validation/` is shared by lanes 9/16/17; worker9's process overwrote my `wave300-10lanes.check.txt` and removed `wave300-10lanes.json` mid-validation. Lesson: validation evidence files must be worker-namespaced (`*.worker16.*`) or the next lane's run silently replaces your results.
10. **Internal vs cross-partition conflicts:** the planner flags within-partition conflicts (same-lane tasks sharing a docs dir) in its own `internalConflicts` — the checker only gates *across* partitions. The two tools answer different questions; use both.

## Assets
- `docs/partition-validation/wave300-10lanes.json` — experiment (a) input, regenerated 23:35 PDT (with `_provenance` per lane)
- `docs/partition-validation/wave300-10lanes.worker16.check.txt` — experiment (a) raw tool output (32 overlaps). `wave300-10lanes.check.txt` in the same dir is a sibling lane's planner-run output, not mine.
- `docs/partition-validation/qa2-collision.json` / `.check.txt` — experiment (b)
- `docs/partition-validation/swarm40-tasks.json` — experiment (c) planner input (48 tasks, 8 injected conflicts)
- `docs/partition-validation/swarm40-plan.json` / `swarm40-plan.stdout.txt` — experiment (c) real planner output + stdout
- `docs/partition-validation/swarm40-plan.check-input.json` / `swarm40-plan.check.txt` — experiment (c) checker verification of the planner's output
- `docs/partition-validation/swarm40-planner-output.json` / `.check.txt` — preliminary manual-assignment stand-in (superseded by the real planner run)
- `docs/partition-validation/swarm40-negative-control.json` / `.check.txt` — experiment (c) negative control
- `docs/partition-validation/wave300-10lanes-plan.json` / `wave300-10lanes-check-input.json` — worker9's planner artifacts over the wave300 input (their work, carried in this branch)
