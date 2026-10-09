# PARTITION-VALIDATION — historical validation of partition tooling

Worker: wave500-coord-cost-worker16 (coord-cost lane, WAVE-500)
Date: 2026-10-08/09 (Thu ~19:00–20:05 PDT)
Claim: `wave500-coord-cost-partition-validation` via claim.sh (first-claim-wins; no sibling lane owned validation)

## Tooling under test

- `scripts/partition-check.mjs` — PRESENT (untracked, owned by wave500-coord-cost-worker10; not committed by this worker). Overlap gate across four axes: (a) file/dir incl. dir-prefix containment, (b) branch-name equality, (c) claim-id namespace, (d) worktree nesting. Exit 0=PASS, 1=FAIL, 2=input error. Its own unit suite: **4/4 pass** (`node scripts/partition-check.test.mjs`, 2026-10-08).
- `scripts/partition-plan.mjs` — **MISSING.** worker9 claimed `wave500-coord-cost-file-scripts/partition-plan.mjs` in the claim registry, but the file never landed in the tree (checked `scripts/` — no partition-plan.mjs, no PARTITION-PLANNER doc). Experiment (c) therefore validates the checker's *output contract* with a manually built planner-style partition, and notes the gap. **Follow-up owed to worker9: land scripts/partition-plan.mjs.**

Method for all experiments: run the real `scripts/partition-check.mjs` against JSON partitions; raw tool output saved under `docs/partition-validation/*.check.txt` (transcribed verbatim below).

---

## Experiment (a) — WAVE-300 ten-lane partition, real branch/worktree/file data

**Verdict: checker FAILS — 31 overlap(s) across 10 partitions (45 pairs).**
Full output: `docs/partition-validation/wave300-10lanes.check.txt`

### Reconstruction method
- 8 of 10 lanes verified against live data: branch names read from the actual lane checkouts (e.g. `pr-wave300-backpressure` → `wave300/honest-backpressure`, `pr-wave300-fanout` → `wave300-fanout-perf`, `pr-wave300-payloads` → `wave300/payload-store`, `pr-wave300-replay` → `wave300/replay-harness`; `wave300/data-plane-fastpath`, `wave300/sharded-claim-boards`, `wave300/telemetry-prod`, `guild-claimsboard/lease-first-reaper` verified as origin refs); file sets = `git diff --name-only` of each branch vs its own origin/main merge-base (read-only, never touched the lane repos).
- 2 lanes (`wave300/stranger-qa`, `wave300/burn-down`) have no surviving branch or worktree: reconstructed with topic-derived placeholder file sets, clearly marked in `_provenance`. Verdicts on the 8 pairs involving them are **unvalidated** (see false-positive FP-1).
- Claim IDs were synthesized (`wave300-<lane>-01`); the historical per-lane claim IDs are not recoverable, so the claim-id axis verdict is weak by construction. All branch names, worktrees, and 8/10 file sets are real.

### The 31 overlaps (by file)
| file | pairs hit | count |
|---|---|---|
| `docs/openapi.yaml` | dp×bp, dp×fan, dp×shards, dp×pay, bp×fan, bp×shards, bp×pay, fan×shards, fan×pay, shards×pay | 10 |
| `server/http.mjs` | bp×fan, bp×shards, bp×pay, bp×tel, fan×shards, fan×pay, fan×tel, shards×pay, shards×tel, pay×tel | 10 |
| `server/work-claim-routes.mjs` | dp×fan, dp×shards, fan×shards | 3 |
| `server/work-claim-sqlite.mjs` | reaper×fan, reaper×shards, fan×shards | 3 |
| `scripts/runtime-package.mjs` | reaper×pay, reaper×tel, pay×tel | 3 |
| `server/work-claims.mjs` | reaper×shards | 1 |
| `server/mcp-full-profile.mjs` | dp×fan | 1 |

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

## Experiment (c) — synthetic 40-task partition (planner stand-in)

**Verdict: PASS (exit 0) on the disjoint assignment; negative control FAILS exactly on the injected collision.**
Full outputs: `docs/partition-validation/swarm40-planner-output.check.txt`, `docs/partition-validation/swarm40-negative-control.check.txt`

- Built 40 synthetic tasks (5 per lane × 8 lanes, topics modeled on wave-300 lane families), assigned disjointly the way a partition planner must: per-lane dirs `server/synth/<t>/` + `tests/synth-<t>/`, one per-lane doc, sibling worktrees `/home/hatch/workspace/pr-synth-<t>`, distinct branches `synth/<t>`, distinct claim namespaces `synth-<t>-NN`.
- Checker: `PASS — 8 partitions, zero overlaps` — a planner emitting a truly disjoint partition clears the gate.
- Negative control (same input, one shared file `server/synth/shared-registry.mjs` injected into lanes 2 and 5): `FAIL — 1 overlap(s)` naming exactly that file pair. The gate is not vacuously passing.

---

## False positives / negatives / caveats

1. **FP-1 (reconstructed lanes):** `wave300/stranger-qa` and `wave300/burn-down` file sets are topic-derived placeholders. Zero-overlap verdicts on the 8 pairs touching them say nothing about history.
2. **FP-2 (file granularity):** registry artifacts (`openapi.yaml`, `http.mjs`, `runtime-package.mjs`) will always flag when lanes behave correctly. Consider an allowlist-with-protocol for known registry files, or section/line-range scoping, to keep the gate signal-to-noise usable at 45+ pairs.
3. **FP-3 (merge-base drift):** lane file sets were computed against each lane repo's own `origin/main`, which sit at different main SHAs. Files merged to main between a lane's base and now may be misattributed.
4. **FN-1 (claim-id axis):** historical wave-300 claim IDs unrecoverable; synthesized IDs prove only that the axis *runs*, not that history was clean on it.
5. **FN-2 (what the checker can't see):** same-file different-line edits (the `#1436`/`#1443` class: same file, overlapping *hunks*) vs same-file disjoint edits — the checker treats both identically. It is a collision *gate*, not a merge oracle. Conversely, it misses cross-file semantic coupling (e.g. lane A changes an API that lane B's untouched file consumes).
6. **Coverage note:** the replay lane had three sub-worktrees (replay-w1/w2/w3); only the harness branch was modeled as the lane partition. Sub-partition overlap inside a lane is out of scope for the lane-level gate.
7. **Missing planner:** experiment (c) substitutes a manual disjoint assignment for the missing `scripts/partition-plan.mjs`. End-to-end planner→checker validation is still owed once worker9 lands the planner.

## Assets
- `docs/partition-validation/wave300-10lanes.json` — experiment (a) input (with `_provenance` per lane)
- `docs/partition-validation/wave300-10lanes.check.txt` — experiment (a) raw tool output
- `docs/partition-validation/qa2-collision.json` / `.check.txt` — experiment (b)
- `docs/partition-validation/swarm40-planner-output.json` / `.check.txt` — experiment (c)
- `docs/partition-validation/swarm40-negative-control.json` / `.check.txt` — experiment (c) negative control
