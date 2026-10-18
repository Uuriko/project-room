# Entity projection checkpoint

This continues the architecture execution plan after `84676b7a`. It is local,
opt-in implementation work. No deployment, production flag or rollback admission
is implied by these results.

## Implemented boundary

Qualified message writes store `{id, _entity: 1}` working-set entries. Normalized
records and bounded reducer edit history are the reference authority. The message
command service prepares the carrier and persists entities/certification; RoomStore
retains authorization, idempotency, event/receipt persistence and the enclosing
transaction. A failed entity write rolls the whole command back.

Schema 40 rejects older writers before references are accepted, including an
already-open schema 39 connection. Hydration works with the option disabled and
on read-only reopen. Unsupported commands return safely to inline state; legacy
rows without reducer history stay inline. Corrupt/missing referenced entities
fail closed. Reverse migration validates disk state rather than cached state.

Compaction preserves references. Conversation fallback consults normalized rows
only when the stored projection contains references; an ordinary uncertified
mirror remains ineligible. The old body-reference codec is expanded before its
storage is released. Channel repair hydrates records before changing shape.
Account deletion clears current records and reducer history through the real
HTTP confirmation/deletion flow. Resumable backfill detaches current serving
records before replay can rewind or delete normalized rows; one-event batches
are tested with reads between commits, both with and without archived history.
This fallback may rehydrate full history. Separate replay staging is a required
next step before the normalized table can become unconditional serving authority.

## Evidence and limits

The fixed-head in-memory comparison at 10k messages measured post-edit projection
size 7,147 bytes inline versus 1,040 with references; SQL binding representations
were 15,984 versus 9,792 bytes. Median latency was approximately 2.655 ms in both
modes. References added one prepared query. This is a write-volume improvement,
not evidence of a latency improvement.

The first disk-backed run used Node 26.8.2 on macOS while the full suite was
running. Independent databases received equal revision sequences in alternating
mode order. WAL was truncated before each timed command; synchronous mode was
FULL. Across 12 measured edits at both 1k and 10k history, median WAL file bytes
were 78,312 inline versus 70,072 with references, a 10.5% reduction. Latency was
noisy and is not a reliable comparison under that contention. WAL file bytes
include SQLite framing and are not filesystem physical-device write counters.

Reproduce with `scripts/benchmark-message-boundaries.mjs` and
`scripts/benchmark-message-wal.mjs`. Each accepts message counts from 10 to 100k.
The latter commits synthetic edits and deletes its temporary databases afterward.
No credentials or production database is used.

## What this does not complete

Reducers still receive the retained working set; reference lists and other room
aggregates still serialize. Retention can exceed the configured window for pins,
open questions and cross-domain dependencies. This is not a hard constant-space
or constant-time bound. Unqualified commands can expand records back inline.

The next writer cutover needs explicit entity contexts and touched-entity output,
then independent work/attempt/artifact writers. Scheduling, placement and the full
human/agent contract stages remain unfinished. See
[ARCHITECTURE-EXECUTION-PLAN.md](ARCHITECTURE-EXECUTION-PLAN.md) for their exit criteria.


## Qualification so far

- 39 focused backfill, continuity, old-writer and Workers checks passed after the
  replay/serving handoff repair, on Node 24.19.0.
- 41 command-boundary, conversation, account-deletion and Workers checks passed
  after extracting persistence; 23 continuity/codec checks passed after old-body
  compatibility was added. These runs overlap and are not additive totals.
- Cold runtime packaging/import closure passed; recovery and both at-rest codecs
  passed in the preceding 52-test focused run.
- Repository gates passed with CI mode skipping duplicate unit execution;
  documentation checks cover 507 links.
- Localization scope now includes the extracted message reducer without raising
  string-count limits; all 19 harness tests passed after that inventory commit.

The broad Node 26.8.2 run completed with 11,073 tests: 11,038 passed, 27 failed,
8 skipped (599.6 seconds). It ran during edits and is not a final-tree certificate.
Twenty-three failures require the Linux host sandbox unavailable on this Mac.
The conversation table-access regression was repaired and rechecked in the
34-test conversation/continuity/Workers run. The two localization inventory
failures passed after the scope commit (19 tests). The PNG golden differed on
Node 26; all four render checks pass on the project's Node 24.19.0 runtime.
No sandbox bypass or weakened golden assertion was introduced.
