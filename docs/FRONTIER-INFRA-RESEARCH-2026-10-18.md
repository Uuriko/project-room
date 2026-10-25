# Project Room: frontier infrastructure research and experimental architecture

Research date: 18 October 2026. This is a decision document for the ongoing
architecture overhaul, not a claim that research prototypes have been reproduced
or that Project Room already leads its category. Sources below are papers,
authors' implementations, official documentation and development discussions.
Publication dates are distinguished from crawl dates. Proposed targets are ours;
paper results are not predictions for this codebase.

## Decision

Build an entity-oriented room runtime with incremental read models, resumable
agent runs and explicit effect ownership. Keep the transaction boundary small
and local to a room. Make recovery a first-class, independently budgeted path.
Treat the interface presented to humans and agents as two views over the same
committed facts, permissions and revisions.

The first implementation priority remains removing the room document from
ordinary entity writes. Pair that with a reproducible performance and failure
harness. Then incrementally maintain the expensive read models and move agent
execution onto a durable step/effect ledger. Do not make a distributed database
rewrite a prerequisite for these changes.

This is an ambitious architecture change: features must stop reaching into a
universal room object. Each domain owns typed commands, explicit dependencies,
entity revisions, persistence, migrations, read models and contract tests.
RoomStore composes them and coordinates transactions. It should not contain the
implementation of every domain.

## What our measurements establish

The schema 40 archived-edit benchmark at 100k messages took about 44.8 ms with
entity references despite a small working projection. Separating the historical
replay JSON from frequently advanced cursor metadata reduced that workload to
about 0.76 ms in the snapshot-split experiment. This is evidence that physical
storage layout matters even when application-level query counts look bounded.
It does not establish network latency, p99, hot-room throughput or recovery time.

Schema 41 now stages replay separately from serving records, publishes at an
exact head, and preserves current reads between replay batches. Publication
failure rolls back rows, checkpoint and metadata together. Deletion scrubs staged
text. The current initial publication still has an unbounded transaction, and
full replay still operates on growing state. These are remaining design defects,
not acceptable permanent tradeoffs.

See [the replay implementation and measurements](MESSAGE-REPLAY-ISOLATION-PLAN.md)
and [machine-readable results](message-replay-benchmark-results.json).

## Research with the highest expected value

### 1. Incremental computation: DBSP and Enzyme

**Evidence.** DBSP gives a compositional model for incremental view maintenance;
the 2025 journal publication extends a research line published earlier. Enzyme's
2026 paper describes a production system that chooses refresh strategies,
versions query fingerprints, compares incremental results with full recomputation
and retains a recomputation fallback. Its workload is analytical pipelines,
not a low-latency room application. [DBSP, May 2025](https://doi.org/10.1007/s00778-025-00922-y),
[Enzyme, March 2026](https://arxiv.org/html/2603.27775v1).

**Our application.** Maintain unread counts, attention candidates, work summaries,
agent context fragments and subscription invalidations from typed entity deltas.
Record which entity revisions and policy revisions produced each view. Start
with a few explicit reducers; a general SQL incrementalization compiler would
be premature. Use a bounded dirty-key queue when immediate derivation is costly.
Deletion and access revocation must invalidate relevant results synchronously.

**Experiment.** Compare full derivation, hand-maintained deltas and dirty-key
recomputation on identical event traces. Include edits, deletes, revocations,
clock rollback, policy changes and high fanout. Require identical authorized
results after every settled revision. Measure work per changed entity and the
crossover at which rebuilding a partition is cheaper than applying its deltas.

### 2. Database-oriented durable workflows

**Evidence.** The CIDR 2026 workflow paper separates durability from workflow-wide
correctness and compares transactional execution with compensation. Current DBOS
documentation distinguishes retriable steps from exactly-once committed database
transactions. That distinction matters: a database cannot alone guarantee an
external side effect happens once after an ambiguous network failure.
[CIDR paper](https://www.vldb.org/cidrdb/papers/2026/p9-stonebraker.pdf),
[DBOS architecture](https://docs.dbos.dev/architecture).

**Our application.** Persist a run's state transition, due work and effect intent
with its domain changes. Keep long model calls outside database transactions.
A worker claims a step with a monotonically increasing fencing token. Results
commit only if that token still owns the attempt. Record model/tool observations
as durable facts so recovery does not rerun a nondeterministic decision merely
to discover which step happened next.

**Experiment.** Compare the existing scheduler with a small room-local execution
ledger. Kill the process before and after every commit and external-response
boundary. Test duplicate delivery, cancellation, stale workers and lease expiry.
External operations need a stable sink idempotency key or an explicit unknown
outcome with reconciliation. Measure successful completed work, not attempts.

### 3. Semantic isolation for long-running agents

**Evidence.** The August 2026 SemIso preprint distinguishes stable resource
bindings, compatibility between resources and inheritance across continuations.
Its prototype uses manifests and declared compatibility contracts. The reported
repository audit identifies exposure conditions, not observed production
incidents. This is early research, not a mature interoperability standard.
[BEGIN AI TRANSACTION](https://arxiv.org/html/2608.05412v1).

**Our application.** Give each run a manifest containing code/tool schema versions,
prompt hash, model identity when available, retrieval-index generation and input
entity revisions. Children inherit that context. Before applying a result,
revalidate the relevant entity revisions and current authority. Historical
context must never freeze permission to act after access has been revoked.
For a mutable provider that cannot supply an immutable version, retain the
observed request/response and disclose the weaker replay guarantee.

**Experiment.** Resume a paused run after changing its prompt, model alias,
retrieval index and tool contract. The system must either preserve a coherent
binding, explicitly replan, or refuse an incompatible continuation. Test branch
merges and context deletion. Measure manifest overhead and retained bytes.

### 4. Durable action identity, beyond request-token deduplication

**Evidence.** The August 2026 CapLease preprint studies repeated authorization
under newly issued tokens. Its experiments compare a protocol with an equally
stateful server ledger and explicitly show that external exactly-once effects
also require an idempotent sink. Canonicalizing equivalent actions remains a
limitation, so semantic equivalence is not magically solved by a hash.
[CapLease](https://arxiv.org/html/2608.01710v1).

**Our application.** Bind an approved action to a stable operation identity,
canonical parameters, scope, revision and execution budget. Retries and agent
replanning reuse the operation rather than spending the same authorization
again. Start with tool-specific canonicalizers and exact typed contracts;
do not let a language model decide whether permission has already been consumed.
Audit existing command receipts and effect records before creating new tables.

### 5. Recovery generations and delta checkpoints

**Evidence.** DeltaBox's May/June 2026 preprint uses changed filesystem/process
state to accelerate sandbox checkpoint and rollback. It reports 14 ms checkpoint
and 5 ms rollback in its evaluation. Those numbers concern an OS-level sandbox,
not our JavaScript reducer or SQLite recovery path.
[DeltaBox](https://arxiv.org/abs/2605.22781).

**Our proposed design.** Replace the growing replay JSON with bounded entity
checkpoints under an inactive generation. Rebuild in small batches, catch up to
a recorded journal head, validate counts and semantic digests, then switch a
small generation pointer with a compare-and-swap on the head/epoch. Keep serving
the previous generation throughout. This generation design is our inference,
not an algorithm claimed by the DeltaBox paper.

The hard parts are deletion across all retained generations, writers racing the
last catch-up batch, duplicated temporary storage and safe reclamation. Deletion
must immediately dominate reads of every generation; old snapshots must not
resurrect text. Publication must be fenced, and an abandoned builder must not
publish after a replacement takes ownership. Benchmark generation rebuild
against the current staged JSON implementation before committing to its layout.

### 6. Shared logs and speculative execution

**Evidence.** BtrLog (June 2026) separates low-latency quorum appends from asynchronous
object-storage archival. Mako (OSDI 2025) separates transaction execution from
replication and permits internal speculation; results still wait for replication
before reaching the client. Belfast/SpecLog (OSDI 2025) overlaps application work
with shared-log ordering. These solve distributed-system problems at a different
scale from our current local benchmark.
[BtrLog](https://arxiv.org/html/2606.27051v1),
[Mako](https://www.usenix.org/conference/osdi25/presentation/shen-weihai),
[Belfast](https://www.usenix.org/conference/osdi25/presentation/bhat).

**Decision.** Preserve a future log/placement boundary, but defer a custom quorum
log and speculative cross-room commit protocol. First measure hosted commit time,
network round trips and cross-room demand. A useful experiment now is speculative
read-only preparation against explicit revisions, followed by normal validated
commit. Never publish an uncommitted result as final or let speculative work
perform an external effect. If replication becomes dominant, revisit these papers
with an actual workload and failure model rather than borrowing their headline
throughput numbers.

### 7. Local collaborative state

**Evidence.** Eg-walker (EuroSys 2025) targets efficient collaborative text editing,
including loading and merging long-diverged histories. The authors provide code,
benchmarks and datasets. Its convergence/performance results concern text edits,
not arbitrary domain transactions.
[Eg-walker author page](https://martin.kleppmann.com/2025/04/02/eg-walker-collaborative-text.html).

**Decision.** Consider this for collaborative drafts, plans and offline notes.
Keep permission changes, work claims, execution budgets and effect admission
under the room's transaction authority. Prototype one document surface and test
concurrent/offline edits, large pastes, reconnect and deletion. Measure interaction
latency, merge time, startup memory and retained history. Do not make every room
record a CRDT simply to claim local-first architecture.

## Fresh engineering discussions that change the plan

- **DBOS TypeScript PR 1396, merged 2 October 2026:** listing step metadata had
  fetched output/error payloads and discarded them afterward. The fix selects
  metadata columns at the database boundary. This closely matches our observed
  need to separate small control metadata from large bodies. Audit every list,
  cursor and status endpoint for physical payload access, not merely response
  size. [Maintainer discussion](https://github.com/dbos-inc/dbos-transact-ts/pull/1396).
- **DBOS TypeScript PR 1407, merged 14 October 2026:** recovery ownership and
  startup ordering needed correction when a conductor is active. Our scheduler
  must specify exactly one recovery owner and fence replaced workers; two
  independent recovery mechanisms are not automatically extra reliability.
  [Review and fix](https://github.com/dbos-inc/dbos-transact-ts/pull/1407).
- **SQLite HC-tree, checked 18 October 2026:** the development timeline records
  a 17 October fix for premature visibility during follower commits. The current
  prototype page still lists incomplete crash recovery and other limitations,
  and some status text differs from later sections. Treat the documentation as
  evolving and verify a pinned revision before any experiment. No production
  substitution is justified by the concurrency claim alone.
  [Timeline](https://www.sqlite.org/hctree/timeline),
  [prototype documentation](https://www.sqlite.org/hctree/doc/hctree/doc/hctree/index.html).
- **Pasture issue 13, opened 7 June 2026:** an agent-orchestrator maintainer evaluates
  embedded durable execution against a separate orchestrator to retain a
  single-binary installation. This is an individual project's experience, not
  comparative reliability evidence. It supports testing the operational footprint
  of each option rather than counting advertised features.
  [Discussion](https://github.com/dayvidpham/pasture/issues/13).
- **Bun issue 45171, observed 13 October 2026:** a reported read-only WAL-mode
  compatibility issue on macOS is specific to the reporter's Bun path. It is not
  evidence of a bug in our pinned Node runtime. It reinforces qualifying the
  actual runtime/adapter/backup combination instead of treating a shared API
  name as proof of equivalent storage behavior.
  [Reproducer discussion](https://github.com/oven-sh/bun/issues/45171).

## The experimental program

These are proposed acceptance targets, not achieved SLOs. Tighten them after a
reproducible baseline establishes attainable limits on specified hardware.

| Experiment | What we compare | Initial acceptance target | Reject the design if |
|---|---|---|---|
| Entity command context | current retained room versus explicit message/ancestor context | unrelated history from 1k to 100k changes touched rows/bytes by at most 10%; no full-room serialization | error precedence, receipts, revisions or permissions differ |
| Incremental read models | full fold versus deltas versus dirty-key rebuild | at least 5x less CPU for representative small changes; exact semantic parity | invalidation misses deletion/revocation or depends on an unbounded scan |
| Recovery generations | staged JSON versus entity batches and pointer publication | final publish under 10 ms locally; background batches near a 20 ms budget | published readers mix generations or deleted text reappears |
| Durable agent ledger | existing jobs versus fenced step/effect transitions | every injected restart preserves admitted-operation identity; no stale-owner commit | retries duplicate sink effects or cancellation loses authority |
| Semantic manifests | mutable aliases versus bound compatible resources | all injected incompatible resumes detected; metadata cost reported separately | manifests are bypassable or keep revoked access alive |
| Interactive drafts | existing edit API versus collaborative document prototype | local interaction below 16 ms on a specified client; convergent replay | memory/history grows without a reclamation strategy |
| Overload recovery | normal load, bursts, retries, cold caches and replay | useful throughput recovers after the trigger ends; bounded queues | recovery work prevents serving or retries sustain overload |

A 10 ms publish target cannot be met by moving an unbounded amount of work into
that transaction. The design has to move the work into resumable batches. Likewise,
a sub-millisecond local edit is not an end-to-end response-time promise: browser,
network, authorization, serialization, storage and model inference all need
separate spans.

## Benchmark and correctness system

Use open-loop offered load and measure from intended request time, so an overloaded
server does not make the generator quietly stop sending work and hide the queue.
The original wrk2 implementation explains this coordinated-omission problem;
its millisecond-scale timing limits also make it unsuitable as the only tool for
our sub-millisecond in-process operations. Keep high-resolution local timings and
end-to-end load tests as separate experiments.
[wrk2 methodology](https://github.com/giltene/wrk2).

For every performance report record commit, runtime, SQLite version, adapter,
hardware, durability configuration, dataset, working-set size, concurrency,
offered load, warm/cold state and background work. Report p50/p95/p99 with enough
samples, goodput, queue age, error rate, CPU, heap, SQL rows scanned/returned,
serialized bytes, WAL bytes, replay duration and peak recovery memory. Collect
actual latency samples; twelve edits are useful for diagnosis, not a p99 claim.

Use deterministic scheduling and seeded faults around the real domain code,
then complement that with real SQLite/Workers and process-kill tests. FoundationDB's
published testing approach combines deterministic simulation with performance
and hardware-failure testing; adopting only a simulator would leave adapter
assumptions untested. [FoundationDB testing](https://apple.github.io/foundationdb/testing.html).

Overload is a correctness-adjacent design concern. Metastable-failure research
shows how retry and resource amplification can sustain failure after the initial
trigger ends. Our experiments must include slow storage, model-provider timeouts,
replay, cache loss and noisy tenants together, with bounded admission and retry
budgets. [Metastable failures](https://www.usenix.org/conference/osdi22/presentation/huang-lexiang).

## Execution order and product payoff

1. Finish and commit the current schema 41 qualification. Keep its opt-in serving
   mode until all reader/writer contracts are covered.
2. Build explicit entity command contexts and a differential oracle against the
   existing reducer. Remove whole-room serialization from qualified operations.
3. Use the same typed deltas to maintain attention/context/subscription views.
   Human screens update promptly; agents receive compact changes and references.
4. Replace growing replay snapshots with a bounded builder and generation
   publication. Make recovery pauseable without slowing current conversation.
5. Consolidate durable scheduling, attempt fencing and effect receipts. A human
   can close a laptop and return to a coherent, explainable run state.
6. Add semantic manifests and version-aware resume/branch behavior. Agents act
   on a traceable context and detect when their assumptions have changed.
7. Prototype collaborative drafts and isolated sandbox branching where they
   improve an actual user task. Defer distributed logs and specialized storage
   engines until measurements identify them as the limiting factor.

The product advantage should be observable: fast interaction under long history,
small agent context, reliable continuation, understandable permissions and
recovery that does not require a specialist. Evaluate against representative
alternatives on those tasks, including operating effort and cost per successfully
completed task. A universal “best” claim without that evidence would obscure
which part of the product still needs work.
