# Project Room architecture execution plan

Baseline: `c07a8020`. This is the completion contract for the overhaul, not a
claim that the steps below have shipped. Existing opt-in compaction and the
current-message repository are migration infrastructure.

## Target architecture

Keep one transaction authority per room. Commands validate authorization and
expected entity revisions, update only affected entities, and commit events,
receipts, durable effects and scheduling signals atomically. Read services query
explicit repositories; no domain feature reads a whole room document merely to
find a message. RoomStore becomes composition and transaction coordination.

Separate message, work, attempt and artifact storage from small room metadata.
Keep global identity, routing and cross-room inbox indexes outside the room
execution boundary. Derived caches carry revision keys and never become the
source of authorization. Do not replace one serialized blob with an implicit
full-history load in every repository call.

## Execution order and acceptance criteria

### 1. Finish reader migration

- Inventory all message-array consumers, including assistant, outside-agent,
  guide/growth/orient, reply graphs, exports, recovery and redaction.
- Add explicit repository operations for ordered scans, recent visible records,
  typed records and metadata aggregates. Bound fetch batches. Preserve ordering
  across archived records and retained working-set exceptions.
- Replace each direct consumer or document and test its retention invariant.
- Keep permissions/history floors at the API boundary; redaction must remove
  current and historic text from every serving and export path.
- Pass pre/post-compaction parity, same-head replacement, reopen, revocation,
  deleted-message and private-thread tests in Node and Workers SQLite.
- Exit: no production reader depends accidentally on whole-history projection
  membership. Every remaining array use is classified and tested.

### 2. Replace message writers

- Extract message command handling behind a transaction-scoped message service.
- Store revisions and required bounded edit history separately from room JSON.
  Add migrations and redaction coverage before persisting another history copy.
- Resolve parents and referenced records by indexed ID; eliminate full-log replay
  for ordinary edits/replies and full-message serialization for ordinary posts.
- Unify certification with entity revisions once entity records become canonical;
  remove the temporary double-write and archive restoration paths only after
  parity and reverse migration pass.
- Exit: post/edit/reply cost does not grow with unrelated settled messages;
  duplicate commands, injected failures and crashes preserve exactly one receipt
  and atomic state. Verify query counts, serialized bytes and WAL bytes at
  1k/10k/100k messages, including middle edits and long histories.

### 3. Split work, attempts and artifacts

- Give each aggregate independent storage, revision, repository and command
  handler. Preserve work evidence lineage and cross-entity transaction rules.
- Migrate per aggregate with dual-read comparison, resumable checkpoints,
  corruption detection and reverse migration. Never infer completion from a
  migration cursor alone; validate counts and semantic records.
- Exit: modifying one work item/attempt/artifact does not serialize unrelated
  aggregates. Delete retired serializers and compatibility code after cutover.

### 4. Replace opportunistic scheduling

- Inventory read-triggered sweeps, cron work and global scans.
- Write durable dirty/due records in the originating command transaction.
- A bounded worker claims due tasks with lease/fencing tokens, idempotent effects,
  retry/backoff and a recovery sweep. Coalesce redundant wakeups per domain.
- Exit: ordinary reads perform no job flushing. Restart, duplicate delivery,
  lease expiry and lost wakeups recover without losing work or running a stale
  attempt's side effects. Track queue age, retries and executed/no-op ratio.

### 5. Isolate room execution and placement

- Specify the existing global identity and cross-room inbox contracts first.
- Introduce a routing directory with epochs and one accepting room authority.
- Move a room through freeze, checkpoint, transfer, verification, epoch switch
  and source fencing. Route stale callers safely; never permit dual writers.
- Exit: migration and rollback drills preserve cursors, identities, receipts,
  attachments and inbox visibility. Measure cold starts and hot-room isolation.
- Production rollout is separate from local implementation and verification.

### 6. Complete human/agent contracts

- Bounded evidence packets include revision provenance and omitted-data counts.
- Compound reads use one consistent snapshot and a published byte budget.
- Local drafts survive refresh/offline conflicts without overwriting remote work.
- Resumable attempts carry stable identities, leases, cancellation and fencing.
- Evaluate retrieval precision, task completion, stale-action refusals and time
  to useful action against fixed scenarios, including adversarial/private data.
- Exit: executable end-to-end scenarios demonstrate both human and agent value;
  features do not expose storage mechanics to ordinary users.

### 7. Qualify, remove compatibility paths and release

- Reconcile the isolated branch with current main and concurrent agent changes.
- Run affected, full unit, Workers, browser, migration/reversal and failure tests.
- Record before/after latency distributions, bytes, query counts and memory with
  identical fixtures, alternating samples and explicit cold/warm conditions.
- Set budgets from measured baselines; do not claim arbitrary world-best numbers.
- Remove obsolete paths only after every consumer's cutover evidence is present.
- Release through repository CI and the serialized deployment lane; verify
  production health and rollback. No completed checkbox substitutes for evidence.

## Progress and evidence

- Complete: opt-in working-set carrier, live certification and reversible archive.
- Complete: repository point/batch reads; digest, needs-me, updates, notifications,
  selected work reads and several permission/evidence consumers migrated.
- In progress: remaining readers and query contracts.
- Not implemented: full entity writer cutover, remaining aggregate splits,
  scheduler replacement, placement migration and the full experience scope.

Each checkpoint updates this section with exact code and verification evidence.
The overhaul is complete only when all seven exit criteria are met.

### Executed reader-query checkpoint

Added ordered repository scans with 128-row archive pages, prefix selection,
visible recent-message queries and paged author-time metadata reads. Merged
archive/live ordering is tested across 270 records with pinned exceptions.
Outside-agent, growth, orient, guide, assistant, direct-mention and reply-audit
consumers now use these operations. Assistant ancestry follows referenced
parents instead of constructing a whole-room conversation graph.

Qualification: final affected run 1,771 passed; focused query/compaction/domain
run 28 passed, including Workers SQLite; repository gates passed. The preceding
assistant/query run passed 35 tests and reply/mention checks passed 32. These
results qualify this checkpoint, not the unimplemented stages above.

Remaining reader boundaries include browser snapshot pagination contracts,
public-face/squad consumers, full recovery/export compatibility and remaining
retention-dependent selectors. Author-time aggregation and reply-audit graph
construction still perform explicit history scans; paging limits temporary
memory but does not make their total work constant. Message writers still use
the existing reducer and projection serializer. Rolling mode remains opt-in.
