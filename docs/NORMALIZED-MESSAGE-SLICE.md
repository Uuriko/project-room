# Normalized message storage migration carrier

The existing `messages` table is written in the command transaction. The
conversation reader can use it after parity certification. This carrier keeps
that certification live for supported message mutations and optionally keeps a
small working set in `rooms.projection` instead of rewriting settled history.
Both options default off; this is not a production-wide storage cutover.

## Modes

`new RoomStore(path, { maintainMessageCertification: true })` carries a valid
certificate across post, edit, poll vote, pin and unpin. The old head and event
anchor must match; touched records and query fields are checked before promotion.
Event, normalized rows, receipt and certification commit or roll back together.
The older replay snapshot is retained, so a later backfill reconstructs its delta.
Uncertified rooms, deletion/redaction, imports and unsupported transitions do not
receive an invented certificate. The normal reader falls back until parity passes.

`new RoomStore(path, { messageProjectionWindow: 128 })` also enables certificate
continuity. After initial backfill/parity and an explicit
`store.archiveMessages(roomId, { keepNewest: 128, dryRun: false })`, later commands
compact when the working set exceeds twice the window and the head is certified.
The existing archive format keeps normalized history and retains pins, work
references, active threads and open questions. The window is a target for settled
history, not a hard cap on active dependencies. Compaction now looks up only the
working set's IDs instead of enumerating every normalized history row.

In this mode, an authorized reference to an archived message restores that record
and its archived ancestors for the existing reducer, allowing edits and replies.
Reducer permissions and revisions still apply; failed commands roll restoration
back. Historical restoration currently replays the log and can be expensive.
Default mode retains the earlier archived-message refusal contract.

## Qualification and remaining boundaries

The comparator tests run the real indexed reader and projection fallback at the
same state, comparing current content and stable response fields. Opaque encrypted
cursors are not byte-comparable. Tests cover mutation continuity, DMs, channel
copies, revocation, deletion fallback, duplicate commands, transaction failure,
reopen, bounded working sets, old-message edits/replies and reverse migration.
Workers SQLite has a dedicated fixture/check.

The conversation slice does not establish parity for every legacy consumer of
`state.messages`. Before enabling the rolling mode for user rooms, migrate and
qualify digest, attention, search, snapshots, exports and work/evidence consumers
against normalized history, including old unread DMs and restored dependencies.
This carrier does not remove other growing projection branches or eliminate the
existing reducer/serialization path. It does not make historical edit restoration
bounded. No production environment switch is added.

Reverse migration is `store.rehydrateAllProjections()` with rolling compaction
turned off. Back up and qualify replay/export before operational use. Turning the
constructor option off alone does not restore already archived records.

## Overhaul sequence

1. **This carrier:** live normalized reads and reversible working-set compaction.
2. **Reader cutover:** one message repository for conversation, digest, attention,
   search, evidence and exports; no whole-history `state.messages` dependency.
3. **Writer cutover:** apply mutations to entity records plus small room metadata;
   replace replay-based restoration with bounded entity reconstruction; retain
   atomic events, receipts and effects. Remove legacy message-array serialization.
4. **Other aggregates:** work items, attempts and artifacts gain independent
   revisions/storage. Delete obsolete dual-write paths after migration parity.
5. **Scheduling:** committed-mutation dirty signals and indexed due work, with
   restart recovery; ordinary reads do not scan/flush all job sources.
6. **Placement:** room-specific execution/storage with routing epochs, source
   fencing and tested global identity/inbox semantics. Separate rollout from data
   migration; do not create two accepting authorities.
7. **Human/agent contracts:** bounded evidence packets and compound reads, local
   drafts, resumable fenced attempts, measurable retrieval/action quality.

The roadmap is not complete merely because a latency benchmark improves. Each
stage needs correctness, migration/reversal and workload evidence before rollout.

## Reader repository checkpoint

`server/message-repository.mjs` now owns current-record lookup across the
working set and archived rows. The working set wins; uncertified table records
outside the archive marker are never treated as authoritative. It supports
point and batched lookup, received-message selection and reply existence. Batches
use one JSON binding per 256 IDs to respect Workers parameter limits. Reply
sets are derived once per author per repository instance, avoiding a history
scan per inbox item. Repository instances are request-scoped, never stored on a
RoomStore or reused after a mutation. It is an internal data API, not an
authorization boundary: callers still enforce audience, membership and history.

Migrated consumers include digest, needs-me, updates, notifications, history-floor
checks, selected work context/discussion/result reads, native-result inbox
lookup, moderation, activity, attachment visibility/commit, pin checks, search
response filtering and claim-renewal evidence lookup. Pure work/notification
functions retain injectable records and projection defaults for standalone use.
Tests compare complete digest, attention, updates and notifications before/after
compaction and reopen, including an edited archived DM. Work discussion is tested
with unrelated archived messages, which previously caused a history-reset error.

This is still not the all-reader cutover. Snapshot/export contracts, assistant
and outside-agent consumers, guide/growth/orient scans, reply-context graph
traversal, recovery/redaction audits and aggregate writers require individual
migration or a documented retention invariant. Do not replace `room().state`
with an implicit full-history hydration: that would recreate the original blob
in memory and hide which operations remain unbounded. The writer and placement
stages above remain outstanding; this checkpoint does not enable rolling mode
by default.
