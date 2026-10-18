# Project Room: build-to-completion plan

Active scope: [six-outcome delivery plan](FOCUSED-DELIVERY-PLAN.md). It explicitly narrows earlier feature commitments; the detailed inventory remains evidence, not the active execution queue.

Plan date: 2026-10-18. Starting local checkpoint: `973260d6`.
Owner: Codex implementation, coordinating shared lanes before changes.
Status: planned execution; the overhaul is not finished.

This is the execution order for the [delivery ledger](DELIVERY-LEDGER.md).
The [master vision](ADAPTIVE-PROJECT-ROOM-MASTER-PLAN.md) explains the product;
this document defines build packages, dependencies, outputs and finish gates.
Detailed invariants in the [architecture plan](ARCHITECTURE-EXECUTION-PLAN.md),
[automation design](AUTOMATION-RESEARCH-AND-EXECUTION-DESIGN.md) and
[quality scorecard](QUALITY-AND-PRODUCTIVITY-SCORECARD.md) remain requirements.

## 1. Starting state: what has and has not been accomplished

Qualified local checkpoints include message-domain extraction, repository reader
migration for several consumers, schema 39 normalized history, schema 40 entity
references, and schema 41 replay isolation. These changes reduced one synthetic
100k-history edit median from approximately 44.779 ms to 0.409 ms. They do not
establish production latency, complete canonical writers or a finished overhaul.
Full replay in the latest fixture still took approximately 286 seconds.

Still outstanding: complete reader cutover; canonical message contexts and writer
cutover; independent work/attempt/artifact aggregates; durable scheduling; room
placement; the complete human/agent experience; bounded recovery; connected
automation; evaluated adaptation; final integration, cleanup and release.

The current branch has local qualified changes, not a blanket production
certificate. Before implementation, compare current main and concurrent work so
we do not duplicate completed features or overwrite another agent's changes.
No prior measurement is automatically a baseline for a later changed tree.

## 2. Architecture we are completing

- One accepting transaction authority per room.
- Small room metadata; independent message, work, attempt and artifact records.
- Commands atomically persist touched entities, events, receipts and due effects.
- Explicit, authorized repository reads and bounded consistent context packets.
- One durable scheduling mechanism connected to existing wakes and workflows.
- Versioned execution contexts, stable operation IDs and recoverable attempts.
- Shared capability semantics across human UI, API, CLI and MCP.
- Observations and experiments outside the authoritative domain state, linked by
  task, entity, policy and source revisions.
- Adaptive policies can be tested and reversed; they cannot rewrite authority,
  acceptance criteria or the evidence used to judge their own success.

RoomStore becomes composition and transaction coordination. Moving whole-room
loads behind new class names does not satisfy the architecture.

## 3. Execution rules

Each package produces a coherent code checkpoint, affected tests, before/after
measurements where relevant, a migration/rollback account and an updated ledger.
Do not mark a package complete from file creation, a successful migration cursor,
a generated test alone, or a passing microbenchmark.

Classify an existing capability before extending it: complete and reusable,
partial and extendable, obsolete and removable, or absent. Reuse existing work
wakes, context, capability discovery, receipts, notifications and handoff records.
Remove old paths after demonstrated cutover; leave every temporary path with an
owner and explicit removal gate.

Research experiments end with evidence and an adopt/reject decision. Required
product capabilities still need an implementation if an experimental approach
loses. New ideas enter the ledger; they do not reset the critical path.

## 4. Ordered build packages

### B00 — Reconcile scope and establish baselines

**Dependencies:** none. **Ledger:** G1, AU1, initial M1/M2 definitions.

- Compare this isolated branch with current main and active agent lanes.
- Read earlier strategy/plan sources and map each accepted commitment to a ledger
  ID, existing implementation or explicit unresolved requirement.
- Inventory direct room-array access, projection writes, opportunistic sweeps,
  automation entry points and duplicate capability definitions.
- Define task episode records and the twelve scorecard scenarios. Capture current
  behavior before changing the relevant path; pilot user studies come later.
- Create a consumer cutover matrix and temporary-path removal register. Each row
  identifies code owner, dependency, current behavior, test and removal condition.

**Exit:** no known accepted item lacks a disposition; all changed boundaries have
an initial inventory and a reproducible baseline. Unknown historical sources are
listed as unresolved, not silently declared reconciled.

### B01 — Complete canonical message reads and writes

**Dependencies:** B00. **Ledger:** A1, A2; preserve A2.1.

- Introduce a transaction-scoped entity context supplying the command's target,
  ancestry and affected receipt bindings without assembling full room history.
- Make domain application return touched IDs and shared metadata changes.
- Persist entity revisions, event, receipt and effects in the existing transaction;
  preserve ordering of authorization, idempotency and revision checks.
- Complete remaining readers or document their deliberate full-scan contract.
- Cut over qualification/certification and remove restoration/dual-write code
  after parity and reversal. Preserve current privacy and history-floor semantics.

**Exit tests:** posts, edits, replies, polls, pins, deletion, receipt withdrawal,
rejected commands, duplicate commands, concurrent revisions, same-head replacement,
private history, cross-domain references, cold packaging and reverse migration.
Measure queries, bindings, CPU and WAL at 1k/10k/100k with fixed touched sets.
Ordinary commands must not serialize unrelated messages.

### B02 — Separate work, attempts and artifacts

**Dependencies:** B01. **Ledger:** A3, R3/R4 contracts, A6 foundations.

- Migrate one aggregate at a time to independent storage, repository and revision.
- Preserve dependency, claim, verification, decision and evidence lineage.
- Add durable attempt/context references and stable logical effect identity.
- Distinguish artifact revision, verification revision and acceptance decision.
- Implement resumable migration, semantic comparison, corruption refusal and
  reverse migration before retiring serialized aggregate representations.

**Exit:** changing one aggregate leaves unrelated aggregates unmodified; effects
and receipts remain atomic; interrupted attempts can be reconstructed from durable
records without replaying an entire conversation. Cross-domain transactions and
privacy deletion work through every new representation.

### B03 — Replace scheduling and complete effect recovery

**Dependencies:** B02. **Ledger:** A4, R3, R4, recovery part of AU4.

- Commit dirty/due records in originating commands; reuse existing wake semantics.
- Add bounded claims, fencing tokens, backoff, coalescing, cancellation and budgets.
- Recheck authority and input revisions when work executes, including resumed work.
- Reconcile uncertain external outcomes; do not blindly retry a non-idempotent sink.
- Move each sweep/read-triggered maintenance path to explicit due work. Retain a
  bounded reconciliation sweep for missed signals and time-based requirements.
- Record suppressed, superseded, completed, failed and uncertain outcomes.

**Exit:** normal reads perform no job flushing; crash, duplicate delivery, stale
worker, expired lease, cancellation, permission revocation and trigger-loop tests
pass. An injected non-idempotent external sink demonstrates the uncertain-outcome
path rather than falsely passing an exactly-once assertion.

### B04 — Connect the first complete product journey

**Dependencies:** B02 for contracts; B03 for automated execution.
**Ledger:** P1, P2, AU2, contract part of AU4, A6.

- Extend existing capability definitions to include typed inputs/results,
  permissions, revisions, limits, recoverable errors and executable examples.
- Make UI/API/CLI/MCP use the same domain behavior.
- Connect dependency resolution → readiness → allowed attempt → artifact → checks
  → review packet → acceptance or continuation.
- Invalidate relevant checks when artifact or dependency revisions change.
- Present meaningful state changes, next decisions, previews and failures in
  existing work views. Add cancellation and correction paths.
- Exercise fresh-agent join/orient, work-to-verified-result and interrupted handoff.

**Exit:** all three journeys are executable without hidden setup; stale evidence
cannot imply current success; equivalent interfaces enforce identical authority;
review packets reference exact artifacts. Measure acceptance, human preparation,
blocked time, interruptions and exceptions against B00.

### B05 — Complete knowledge, drafts and commitment continuity

**Dependencies:** B02, B04. **Ledger:** P4, AU3, remaining A6, groundwork for AU6.

- Store knowledge with source, scope, version, correction and retention semantics.
- Deliver byte-budgeted context with provenance, omissions and follow-up reads.
- Propagate source deletion and permission revocation through summaries/caches.
- Implement local drafts and explicit conflict handling across refresh/offline.
- Reconcile accepted commitments against work records and source decisions;
  suggest missing mappings or contradictions without silently discarding work.
- Finish keyboard, screen-reader, responsive and comprehensible state flows.

**Exit:** a fresh person or agent can resume without repeating necessary context;
contradictions and missing sources are visible; offline edits do not overwrite
remote work; all three core journeys work with assistive technology.

### B06 — Bound rebuilding and isolate room placement

**Dependencies:** B01–B03. Can precede B05 if measurements show recovery is blocking.
**Ledger:** R1, R2, R5, A5.

- Compare incremental views with full recomputation using realistic deltas.
- Prototype chunked replay generations and a small atomic publication switch;
  measure total rebuild cost, storage amplification and publication pause separately.
- Qualify concurrent writes, cancellation, privacy changes and crash recovery during
  a rebuild. Adopt a candidate only when it improves the measured constraints.
- Specify global identity and cross-room inbox contracts; implement placement
  epochs, source fencing, verified transfer and rollback with one accepting writer.
- Measure noisy-neighbor isolation, cold starts, overload and tail latency using
  appropriate open-loop tests.

**Exit:** recovery is demonstrably bounded at declared workload limits; room moves
preserve receipts, identities, attachments and cursors; stale writers cannot commit.
If a research approach fails, retain the requirement and implement another design.

### B07 — Build the measurement and regression loop

**Dependencies:** B04; telemetry baseline began in B00.
**Ledger:** AD1, P3, M1/M2, AU5 foundations.

- Connect task episode, policy, model/runtime and artifact versions to observations.
- Build reviewed, sanitized failure-to-fixture promotion with independent oracles.
- Add immutable experiment records: hypothesis, baseline, cohort, dataset versions,
  allowed changes, budget, quality/cost guardrails, evidence and disposition.
- Run a pilot comparison against the current workflow and strong alternatives.
  Include failures, review and repair effort; size subsequent studies from variance.
- Check measurement integrity and prevent double-counting split tasks or retries.

**Exit:** a report can reproduce its inputs and distinguish improvements from
measurement errors; the old failure is detected by the new regression case;
privacy and retention controls cover traces and derived examples.

### B08 — Add bounded adaptation and automated improvement

**Dependencies:** B03, B05, B07. **Ledger:** AD2–AD4, AU5/AU6, P5 experiments.

- Build offline/shadow candidate evaluation with hidden transfer cases, repeated
  trials and independent grading. Test a deterministic policy before prompt search.
- Compare cache/retrieval, batching/concurrency and model/tool routing policies
  using quality-matched latency, resource use and accepted-outcome cost.
- Add prompt candidates and research-to-experiment proposals with bounded budgets.
- Keep baseline and candidate policies versioned; simulate drift, budget exhaustion
  and rollback. Prevent optimizers from changing their own acceptance criteria.
- Automate documentation checks, maintenance rehearsals and quiet project briefs.
- Evaluate only environment/connector adapters needed by the core journeys;
  qualify warm/cold reconstruction and external effect identity.

**Exit:** the system can propose a candidate, establish a real improvement or reject
it, stop at budget, and revert a regression. Automatic adoption stays within
explicit reversible-policy scope; code/schema changes are reviewable artifacts.
Record outcomes for every experiment, including rejected ideas and remaining
capability requirements.

### B09 — Integrate, remove compatibility paths and qualify release

**Dependencies:** B01–B08; reconciled B00. **Ledger:** A7 plus final G1/M1/M2.

- Reconcile with current main and concurrent work incrementally, then certify the
  exact final tree. Revalidate any affected evidence after integration changes.
- Remove obsolete serializers, restoration paths, duplicate scheduling and retired
  interfaces only when the consumer matrix demonstrates cutover.
- Run full supported-platform unit, Workers, browser, migration/reversal, privacy,
  fault and packaging checks; record platform exclusions explicitly.
- Verify export/import, recovery drills, operational runbooks and observability.
- Publish internal comparative results with uncertainty, limitations and failed
  scenarios. Product ambitions remain hypotheses until evidence supports them.
- Prepare rollout/rollback artifacts. Deploy only with current-session authorization
  and the serialized lane; verify the deployed version before declaring shipped.

**Exit:** every required ledger item has implementation and verification evidence;
research items have explicit outcomes; all original seven architecture exit criteria
are satisfied. Any remaining accepted capability keeps overall completion open.

## 5. Scope coverage: no item silently lost

| Ledger scope | Build packages |
|---|---|
| A1, A2, A2.1 | B01, preserve existing replay checkpoint; B09 final qualification |
| A3 | B02 |
| A4 | B03 |
| A5 | B06 |
| A6 | B02, B04, B05 |
| A7 | B09 |
| R1, R2, R5 | B06 |
| R3, R4 | B02 contracts, B03 implementation |
| P1, P2 | B04 |
| P3 | B07 |
| P4 | B05 |
| P5 | B08 |
| M1, M2 | B00 baseline, B04/B07 comparisons, B09 final evidence |
| G1 | B00 and B09 |
| AU1 | B00 |
| AU2 | B04 |
| AU3 | B05 |
| AU4 | B03/B04 |
| AU5 | B07/B08 |
| AU6 | B05/B08 |
| AD1 | B07 |
| AD2, AD3, AD4 | B08 |

Dependencies in the ledger describe capability relationships. For execution use
the package order above: baseline measurement in B00 does not require final M2
qualification, R3 contracts start before scheduler implementation, and A6 contracts
start before the completed experience. This avoids accidental planning cycles.

## 6. Measures that decide whether we are done

Primary outcomes: accepted work per active human hour and elapsed time to verified
acceptance. Include failures, review, corrections, coordination and recovery.

Per-package diagnostics: unrelated-history cost growth; replay/publish bounds;
blocked duration; stale-evidence rate; commitment omissions; context reconstruction;
first-pass acceptance; unattended success; exception burden; cost per accepted
outcome; notification usefulness; change effort and accessibility task success.

Hard conformance gates: no unauthorized disclosure/action, lost acknowledged state,
stale-worker writes, silently stale verification or unsafe migration under the
specified tests and fault model. Passing finite tests does not prove universal
absence of failure. Numerical performance/productivity targets in the scorecard
are provisional until baselines and repeatable comparisons justify them.

## 7. Immediate next implementation prompt

> Start B00 and B01 from the current isolated branch. Read coordination state and
> compare relevant upstream changes. Create the consumer cutover and temporary-path
> removal inventories, preserving every accepted ledger item. Then implement a
> transaction-scoped message entity context and explicit touched outputs using the
> existing message-domain semantics. Keep authorization/idempotency ordering and
> cross-domain receipt behavior intact. Differentially test supported and rejected
> commands, privacy, retries, rollback and reversal. Demonstrate that unrelated
> message history is not serialized on ordinary commands. Record the exact revision,
> tests and 1k/10k/100k comparison. Update the ledger honestly and proceed to B02
> when the exit criteria are met. Do not substitute further strategy documents for
> implementation, and do not silently mark unresolved compatibility paths complete.

The plan is complete as a planning artifact. No build package is marked complete
by this document; execution status remains in the ledger.
