# Message replay isolation execution plan

Starting checkpoint: `6780b79d`. Preserve room authority, current-reader semantics,
privacy deletion and exact retries while removing replay-state coupling from
ordinary message writes.

## Finding

The 100k-history benchmark retained only eight working messages and returned 19
SQL result rows, yet an edit still took roughly 45 ms. A 10k SQL timing profile
identified certificate advancement as the dominant statement: updating small
fields in `messages_backfill_cursor`, whose same row contains the full historical
`state_json`. This storage boundary still couples ordinary writes to history.

## Execution

1. Separate the large replay snapshot from the small certification/cursor row.
   Migrate existing snapshots transactionally, fence incompatible writers, keep
   opening cheap where possible, and retain a tested reverse/compatibility path.
   Redaction/account deletion must scrub every snapshot location.
2. Keep serving progress and replay progress distinct. Replay only changes its
   isolated checkpoint until it reaches an exact room head. Publish touched
   entities and serving progress atomically; do not rewind current records during
   one-event batches or expand serving projections as a maintenance side effect.
3. Reuse the existing replay state as staging rather than adding another private
   message-body copy. Preserve the original posting sequence for changed records.
   Do not publish partial replay at an exact-head certificate.
4. Test interruption/reopen, concurrent live edits, malformed replay, replaced
   history at the same head, publication failure, redaction and account deletion.
   Qualify Node and Workers adapters plus cold runtime packaging.
5. Repeat 1k/10k/100k fixed-head timings, SQL profiles and disk WAL measurements.
   Record setup/replay costs separately. A smaller query result is not proof of
   bounded engine work, and smaller JSON is not proof of lower physical writes.

## Completion criteria

Ordinary certified mutations never update a row containing full replay JSON.
Reads between replay batches keep current content and privacy rules. Failed
publication preserves the previous serving state and resumable replay checkpoint.
The change remains opt-in where reader/writer cutover is incomplete. No production
deployment is part of this local execution.


## Implemented checkpoint (schema 41)

The large replay JSON now lives in `message_replay_snapshots`; the cursor keeps
small serving and staging metadata. Migration physically removes the old JSON
column, copies existing snapshots transactionally and fences already-open older
writers. Recovery includes the new table. Privacy deletion rewrites or discards
staging in the same transaction, including legacy split-snapshot remnants.

`applied_seq` now denotes published serving progress. `state_seq` and
`replay_event_id` denote resumable staging progress; the backfill response exposes
`appliedSeq` and `replaySeq` separately. Partial replay never deletes or rewinds
serving rows. At the exact room head, publication validates authoritative
references, writes affected records with their original posting positions, prunes
stale rows and advances serving progress in one transaction. A failed publication
also rolls back that batch's snapshot and cursor, preserving the prior checkpoint.

Conversation fallback merges archived rows and retained exceptions by posting
sequence. Continuations reset if their read domain changes. Visibility metadata
is filtered in SQLite before archived bodies are fetched; working records are
filtered with the same history-floor and DM/channel rules.

### Measurements

Local synthetic workloads, macOS, Node 24.19.0; twelve measured edits per mode,
two warmups, alternating mode order. Fixed-head edits roll back after the timed
command. These are local measurements under variable machine contention, not
production latency guarantees or isolated statistical trials.

| Measurement | Inline working records | Entity references |
|---|---:|---:|
| Schema 40, 100k archived-edit median | 45.542 ms | 44.779 ms |
| Snapshot split only, 100k archived-edit median | 0.740 ms | 0.762 ms |
| Completed isolation, 1k archived-edit median | 0.650 ms | 0.641 ms |
| Completed isolation, 10k archived-edit median | 1.072 ms | 1.159 ms |
| Completed isolation, 100k archived-edit median | 0.409 ms | 0.409 ms |
| Completed isolation, 1k committed-edit median | 0.771 ms | 0.765 ms |
| Completed isolation, 10k committed-edit median | 0.944 ms | 0.850 ms |
| Completed isolation, median WAL bytes at 1k and 10k | 74,192 | 65,952 |

The final 100k reference result is approximately 109x faster than the schema 40
baseline under these local conditions. Initialization took 133.5 seconds and
replay took 286.4 seconds; those substantial costs remain architectural work. A SQL profile identified the old cursor metadata update as
the dominant cost: the small update shared a SQLite record with history JSON.
The new authorizer test verifies ordinary certified writes never access the
snapshot table. References reduce WAL bytes by 11.1% relative to inline records
in the final disk workload. WAL includes framing and is not a physical-device
write counter. Setup/replay costs are excluded from edit timings; the benchmark
now reports initialization, replay, parity and archival durations separately.

Machine-readable measurements are in
[message-replay-benchmark-results.json](message-replay-benchmark-results.json).

### Qualification and remaining limits

- 88 focused qualification checks passed, including cold runtime packaging,
  migration, recovery, backfill, conversation and account deletion.
- 42 conversation/continuity checks passed after adding pre-decode visibility
  filtering. They include publication failure, live edits between batches,
  interruption/reopen, deletion during staging and archive page ordering.
- Five real Workers migration/repository checks passed after reconstructing the
  old cursor layout, including removal of its JSON column by the new migration.
- The 87-test fence/privacy run passed 86 checks and exposed one stale schema
  version expectation; that expectation was corrected and its migration test
  passed on rerun. Nine lifecycle/Workers checks also passed.
- Additional schema callers passed 127 checks; the final history-floor and
  continuity run passed 32. Metadata-only cursor qualification passed 45.
- Repository gates passed, including lint (zero errors, 290 warnings), secret
  checks and documentation links. These overlapping runs are not additive
  unique-test counts. No final-tree full-suite or production certificate is claimed.

Full replay still folds a large state and writes a large staging snapshot.
Initial publication can rewrite all message rows in one transaction; event-count
budgets do not impose a hard wall-time bound on that final transaction. Retained
working sets can exceed the nominal window, and other room aggregates remain in
the room document. This checkpoint is not completion of the seven-stage overhaul.
The next architectural task is explicit entity command contexts and touched
outputs, followed by independent work/attempt/artifact aggregates. Replay needs
its own bounded builder/publication design before claiming bounded recovery.
