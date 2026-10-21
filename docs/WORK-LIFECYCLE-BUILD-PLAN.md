# Work lifecycle and authority build plan

2026-10-18. Baseline: `3f240e53`. This implements the next chunk of the
[focused delivery plan](FOCUSED-DELIVERY-PLAN.md), with ownership defined in
[the authority decision](WORK-AUTHORITY-DECISION.md). Status is recorded below;
this is not a claim that the whole architectural overhaul is complete.

## Execution prompt

Complete delivery, review, send-back, resumption and acceptance using existing
work and claim mechanisms. Reuse qualified overlapping changes. Preserve exact
review basis, claim-round identity, retries, permissions, evidence and history
through synchronization and restart. Measure work mutation cost as unrelated data
grows. Remove demonstrated unnecessary global work before introducing storage.
Separate canonical work persistence only with lossless migration, atomic command
writes, reader parity, interruption/reversal proofs and removal of the old writer.
Do not create a third task system, fabricate acceptance, or erase historical evidence.

## Build sequence and acceptance

### 1. Reconcile and integrate the existing lifecycle

Inspect PR 4085 (round identity, stale submission fences, delivery reconciliation)
and PR 4090 (send-back, criteria delivery, policy-aware verification, review basis).
Apply their exact commits to this isolated checkout, preserving authorship. Resolve
only composition conflicts. Run their kernel/client tests together with the work
migration tests: isolated green PRs do not establish a green combined product.

Acceptance: deliver → request changes → send back → redeliver → approve → verify;
self-attested criteria-bearing work can deliver and finish; unauthorized verification
is unavailable and server-refused; old submissions cannot affect a reclaimed round;
unknown outcomes require confirmed readback. Exercise desktop and narrow browser.

### 2. Preserve authoritative facts at the existing boundary

Use the existing migration census. Work owns intent and its acceptance; claims own
reservation and board execution; board rendering composes these facts. Do not
synthesize a board approval from work verification: the two bind different evidence.
Preserve existing board review/attestation basis and claim-round counters exactly.
Preserve board-owned linked PR sync records and request receipts. Repeated mapping
must be a fixed point. An unrelated work event must not silently erase a delivery.

Prove each repair with a regression that fails before the implementation. Test
stale evidence and real persistence, not just JSON shape. Keep unresolved authority
conflicts explicit rather than choosing the newest-looking value or weakening gates.

### 3. Measure and remove global synchronization work

Measure mutation phases independently: event fact loading, mapping, writes and
whole-room serialization. Vary unrelated work items and unrelated events separately.
Record sample count, median/tail, rows inspected, queries and payload bytes. A local
microbenchmark is not a production SLA or productivity result.

First compare a targeted command plan to the full backfill plan. Command sync should
map only its changed item and required successor relationships; maintenance backfill
still deliberately scans all items. Restrict fact reads to the affected domain using
an indexed query only if the query plan demonstrates benefit. Preserve divergence
reporting semantics explicitly. Do not turn a last-room snapshot into a misleading
zero after a one-item operation.

### 4. Storage cutover gate

After the semantic boundary is proven, enumerate all readers and writers of
`state.workItems`. Choose the smallest canonical aggregate that retains IDs, revisions,
DoD, roles, receipt histories, verification/decision basis, claims, handoffs and help.
No cutover may silently discard a field from the existing census.

Build copy/compare in one transaction, resumable progress with serving state isolated
from partial migration, fallback for unconverted rooms, and reverse reconstruction.
Commands must atomically persist aggregate, event, idempotency receipt and required
claim changes. Readers must compose from the same committed revision. Exercise
old/new snapshots, interrupted conversion, restart, rollback, privacy and concurrent
stale commands. Remove old whole-room work serialization only after every direct
reader is migrated. Do not permanently retain two independently writable records.

Acceptance: one-item mutation work does not grow with unrelated work/history in the
normalized domain; semantic comparison is exact; reversal restores equivalent state;
there is one writer per fact. If this gate is not met, report the remaining work and
retain the serving path rather than label an opt-in copy a finished overhaul.

### 5. Qualify the combined candidate

Run focused lifecycle, durable HTTP, migration and invariants tests; board browser
and existing work-resume journeys; lint and documentation checks. Run affected tests
against `3f240e53` at the integration checkpoint. Investigate every failure and report
which full commands were rerun. Record source commits and measurements. Keep the
shared production landing lane untouched; local integration is not a deployment.

## Alternatives rejected for this chunk

- Rewrite the board: existing kernels and candidate controls already solve most of
  the journey; preserve that work and spend effort on composition failures.
- Immediately merge tasks into claims: the census proves loss of work semantics.
- Add a recovery coordinator: the existing receipt/retry mechanism already passes
  lost-response and restart tests; improve its round identity instead.
- Start with database tables: faster storage of contradictory facts preserves the
  wrong architecture. Establish ownership and measure the expensive path first.

## Execution evidence

- Reused PR 4085 commits `6de1ba3a`, `a39b69cd`, `fb28a77d`, `14135dc5`
  and PR 4090 `31f994f6` locally. Only string-catalog conflict required manual union.
- First combined run: 62/66 pass. Four migration convergence failures expose the
  missing new claim-round field in the existing mapper. Qualification is ongoing.


### Implemented locally

- Reused and composed both candidate PRs. Four initial mapper/codec convergence
  failures were repaired by retaining claimRound.
- Regression reproduced erased review basis and delivered-state rewind. Mapper
  now preserves board basis/attestations, PR polling outcomes and round identity;
  protects delivery/send-back as explicit divergence; restart test passes.
- Extracted 20 lifecycle/helper functions (about 470 lines) into
  `src/work-reducers.js`, composed with existing authority guards. The central
  event module retains ordering/deduplication and the public event API. Registered
  the module in browser/runtime assets. Updated the executable field-site census.
- Replaced full event decoding in board sync/backfill with an indexed domain fact
  read. The parity test compares the full-history and indexed mapping results.
- Added a real narrow-screen browser journey through criteria delivery, send-back,
  redelivery and self-attested completion. This intentionally remains labeled
  self-attested: clicking Verify does not invent independent verification.

### Measurement and architectural decision

See [raw measurement](work-boundary-results.json) and run
`node scripts/benchmark-work-boundaries.mjs 100 400 1000 10000`.
Local Node 24.19 / SQLite, 12 samples after two warmups, alternating read modes,
fixed command head, excluding rollback. No claim of production latency or a
statistically established universal speedup.

At 1,000 unrelated messages: median 12.606 → 10.871 ms; facts 1,006 → 4 rows.
Bindings remain 915,493 bytes. At 400 unrelated proposed work items: median
12.999 → 12.892 ms, bindings 561,270 bytes, facts 406 → 404. The index removes
unrelated conversation reads but does not solve work scaling. At 10,000 messages
this fixture exceeds the 4 MiB projection cap. Work populations above 500 are
outside the configured supported limit and are explicitly skipped, not credited
as successful benchmarks. An earlier oversized initialization was stopped; it
is not included in the saved result.

### Remaining, not represented as complete

- A board delivery and a work receipt still describe different acceptance models.
  Their disagreement is now preserved and visible in divergence diagnostics,
  not erased. Define explicit cross-door commands before making them one workflow.
- Work mutation still maps all work items and serializes the room. The proposed
  canonical work repository, atomic cutover, reversal and retirement are not built.
- Next implementation must select the work acceptance model as authority, route
  item-backed board acceptance to it with exact evidence, and compose execution
  separately. Re-run the field-fate census, migrate the 58 reference sites through
  that repository, then remove the old work carrier. A new table alone cannot
  satisfy this gate.
- No production deployment or GitHub merge was performed.


Additional integration finding: the two reused PRs composed a send-back control
without the new delivery/verification round fingerprint. A same-owner reclaim
could reuse an old reviewer request ID. A failing release/reclaim/redelivery
regression now passes with round-specific send-back identity; unchanged retries
remain identical. The extracted 20 function bodies were compared byte-for-byte
with `3f240e53` and are unchanged.


### Qualification record

- Initial composed candidate: 2,519 affected tests passed, 2 skipped, zero failures
  (291 files). After domain extraction: 2,442 passed, 2 skipped, zero failures
  (290 files), using `verify-affected --base=3f240e53`.
- Final send-back identity change: 59 focused control/round/HTTP/durable/retry tests
  passed; the real browser delivery/send-back/redelivery/complete test also passed.
- Domain extraction browser run: 12 passed (board desktop/narrow, accessibility,
  stale UI response handling and desktop/phone resume). Worker SQLite: 2 passed.
- Census, persistence and mapping run before extraction: 34 passed. The extracted
  domain's focused run exposed only the expected new reference-site inventory;
  updating the census to 58 sites was included in the green affected run.
- Documentation: 570 links pass. `git diff --check` passes. The i18n scope required
  regeneration for the extracted module; the generator and its check pass.
- These are local qualification results, not a full `npm test`, physical Mac
  sleep/crash test, hosted CI result or production verification.

Final `npm run lint`: exit 0; zero errors, 290 existing warnings; design, reachability, i18n and generated UI-string checks pass.


The subsequent [canonical work cutover](WORK-CUTOVER-PLAN.md) supersedes the
unimplemented-storage and cross-door-acceptance bullets above. It records exact
qualification and remaining aggregate/legacy divergence limitations; the larger
overhaul and v1.0 release gates remain open.
