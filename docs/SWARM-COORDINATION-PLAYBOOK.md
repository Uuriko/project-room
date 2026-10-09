# SWARM COORDINATION PLAYBOOK (WAVE-500 coord-cost lane)

The coordinator's runbook for a 100–500 agent wave. Operational, not aspirational: checklists and commands. Prose is the minimum needed to explain *why*; everything else is a command you can paste.

> SOURCE NOTE (read 2026-10-08 ~17:50 PDT): at this lane's read time **all** sibling lane docs were absent from `~/workspace/pr-wave500-coord-cost/docs/` (and from a `~/workspace` sweep): OVERHEAD-BASELINE, SPAWN-LATENCY, ROOM-CHATTER-COST, BATCH-DISPATCH-SPEC, CONTEXT-PACKING, RECEIPT-SCHEMA, STANDING-CLAIMS-PROPOSAL, LANE-CLAIM-CLI, PARTITION-PLANNER, PARTITION-CHECK, REPORT-NORMALIZER, DIGEST-BUILDER, ASK-BATCHING, OVERHEAD-MODEL. Sections (e) and (f) below are therefore stubs that cite where their numbers must come from. Any figure below not attributed to a sibling doc is qualitative, not measured.

This doc does not duplicate sibling lanes: dispatch internals live in BATCH-DISPATCH-SPEC, context math in CONTEXT-PACKING, receipt fields in RECEIPT-SCHEMA, the overhead model in OVERHEAD-MODEL. This is the *sequence*.

## 0. Standing conventions

- Claim registry: `~/workspace/goals/autonomous-work-engine-never-stop/hidden_files/loop-state/claims.json` **plus** your own `subagent.list` before spawning anything from a live session. Register long-running live-burst claims the same way.
- Ownership knowledge expires in ~15 min. Before the first write of a fix — and before launching a wave — re-fetch the live room event log (last ~100 events) and the work-claims board.
- Standing watches use ONE canonical task ID per watch (`watch-<thing>`); agent-conversation rounds use the round ID. First claimant works, the loser stands down.
- Room scripts' flags are GLOBAL and come before the verb (`scripts/room --dry-run sweep`, never `scripts/room sweep --dry-run`).
- Never `git checkout <ref>` in a shared checkout; read refs via `git show <ref>:<file>` or a disposable worktree.

## (a) Pre-wave

1. **Overlap check gate.** Do this in one turn, in order:
   - [ ] Registry read: claims.json + subagent.list — is any lane or wave already touching this target?
   - [ ] Board grep on `Uuriko/project-room` issue #266 (live claims board): `gh api repos/Uuriko/project-room/issues/266/comments --paginate -q '.[] | select(.body | test("<wave-scope>"; "i")) | {id, user: .user.login, body: .body[:200]}'`
   - [ ] If a sibling session owns it: don't re-dispatch — review or extend theirs. If nobody owns it: claim your canonical wave ID on the board first.
2. **Partition planning.** Pick the partition key that makes overlap impossible by construction (file area, bug class, venue, or buyer segment — one axis only). Author the partition manifest; run the overlap gate against it (PARTITION-CHECK) until zero overlaps. One partition = one claim ID.
3. **Context pack selection.** Pin one pack version for every lane this wave (CONTEXT-PACKING). Every lane reads the same pinned pack + its own partition slice. Never inline per-lane context edits at dispatch time.
4. **Batch-dispatch manifest authoring.** Write the manifest first (BATCH-DISPATCH-SPEC): lane ID, claim ID, partition slice, context-pack version, done condition, receipt sink. Dispatch reads the manifest; the manifest is the wave's single source of truth.

## (b) Launch

**Lane claims vs per-task claims — the decision rule.** Use *lane claims* when the wave is coarse-grained: each lane owns a partition for the whole wave and the overlap check ran on partitions. Use *per-task claims* when the wave is fine-grained and tasks can be re-partitioned mid-flight: every unit of work gets its own claim ID and a worker takes a task only after claiming it. Never mix both on the same unit of work — that is how two workers answer the same inbound twice.

**The one coordinator turn that fires everything.** The coordinator does not hand-spawn lanes across ten turns. It runs the dispatch loop once: for each manifest row, claim the lane's claim ID on the board, then spawn the lane. Verify with a read-back: after the loop, grep the board for the wave's canonical IDs and confirm every claimed ID appears. Claimed-but-not-spawned is a stranded wave; spawned-but-not-claimed is a collision waiting to happen.

## (c) In-flight

**Heartbeat cadence.** Workers do not ping the coordinator on every step. Each lane posts one heartbeat per cadence window (cadence from the manifest; a batch of heartbeat entries, one line per lane). The coordinator reads heartbeats, never individual progress posts. A lane that misses two heartbeats gets one ASK, not a rescue wave.

**ASK batching.** Workers never send one-question round-trips. ASKs are collected and answered once per window (ASK-BATCHING). The coordinator answers the batch in a single message; workers proceed on the rest of their slice while waiting. A question that blocks zero other lanes waits until the batch.

**PROGRESS batching.** Workers batch progress into the heartbeat cadence. Room posts follow the HELLO/CLAIM/PROGRESS/ASK/REVIEW/IDEA/FRICTION/DONE/HANDOFF prefixes; one PROGRESS per lane per window, not per commit.

**Digest-driven monitoring.** The coordinator never reads 25 worker reports. Reports land in normalized form (REPORT-NORMALIZER); the coordinator reads only the digest (DIGEST-BUILDER). Monitoring loop: read digest → check claims registry/board for stuck lanes → batch ASKs → post decisions. If the digest says nothing is stuck, the coordinator does nothing.

## (d) Landing

1. **Receipt validation.** Every lane posts a receipt to the sink named in the manifest. Validate each against RECEIPT-SCHEMA before counting it done: claim ID, exact head SHA, test evidence, what was deleted, what wasn't checked. A lane with no valid receipt is not done.
2. **Digest building.** Rebuild the digest from validated receipts only (DIGEST-BUILDER). The digest — not the room chatter — is the wave's record.
3. **The single room DONE post.** One post, one turn: wave ID, partitions landed, receipt count, digest pointer, known gaps with owner names. No per-lane DONE posts, no victory laps. The post gets a read-back check: re-fetch the event log and confirm the message ID appears.

## (e) The numbers — expected overhead ratio

Overhead ratio = coordinator-side coordination cost (room posts, claim checks, report reads, digest builds, ASK answers) divided by total worker output, at wave sizes N = 100 / 250 / 500.

> PENDING: the model doc (OVERHEAD-MODEL) was missing at this lane's read time. Fill the table from it; do not eyeball. The expectation from this lane's synthesis: without these practices the ratio grows roughly linearly with N (every report read, every room post, every claim check costs per-agent); with them the coordinator's marginal cost per added agent stays near-constant because the coordinator only ever reads the digest and answers batched ASKs.

| Wave size | Without practices (OVERHEAD-MODEL) | With practices (OVERHEAD-MODEL) |
|---|---|---|
| 100 agents | *fill from OVERHEAD-MODEL* | *fill from OVERHEAD-MODEL* |
| 250 agents | *fill from OVERHEAD-MODEL* | *fill from OVERHEAD-MODEL* |
| 500 agents | *fill from OVERHEAD-MODEL* | *fill from OVERHEAD-MODEL* |

Supporting inputs, when they land: per-spawn cost from SPAWN-LATENCY; chatter cost per message from ROOM-CHATTER-COST; baseline overhead from OVERHEAD-BASELINE; context cost per spawn from CONTEXT-PACKING.

## (f) Anti-patterns and their costs

| Anti-pattern | What happens | Cost (fill measured figures from the cited doc) |
|---|---|---|
| **Unpartitioned dispatch** — lanes spawned on overlapping scopes, no partition manifest | Two lanes answer the same inbound / fix the same file; one cycle of work is discarded | *from OVERHEAD-BASELINE / ROOM-CHATTER-COST* |
| **Per-question round-trips** — one ASK at a time, answered ad hoc | Coordinator context-switches per question; workers idle while blocked; room noise grows per question | *from ASK-BATCHING / ROOM-CHATTER-COST* |
| **Free-text reports** — narrative reports the coordinator must read and reconcile | Coordinator reads N reports instead of one digest; reconcile cost scales with N | *from REPORT-NORMALIZER / DIGEST-BUILDER / OVERHEAD-BASELINE* |
| Unclaimed dispatch (spawn without board claim) | Collisions discovered late; the loser stands down only after burning a cycle | *from LANE-CLAIM-CLI / STANDING-CLAIMS-PROPOSAL* |
| Hand-spawning across many turns (no batch dispatch) | Claimed-but-not-spawned gaps; drift between turns; no single read-back | *from BATCH-DISPATCH-SPEC / SPAWN-LATENCY* |
| No receipt gate (landing on room posts alone) | Unverifiable done claims; gaps surface weeks later | *from RECEIPT-SCHEMA* |

Done-checklist for the wave coordinator (John's rule): say what you deleted, say what you didn't check. Nothing here authorizes spending, sends, posts as John, or deploys without his tap.
