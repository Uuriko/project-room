# Bounded replay: executable first format increment

Base: `d3a2bf6399a211ff4acf272f495939cc74115a58`. This is a NEW-file-only
prototype, approved by root for isolated experimentation. Nothing imports it
from the service. No production schema, flags, migration, rows, certificates,
deployment or activation policy changed. Root owns integration and deployment.

## Concrete finding and choice

`messages-store.mjs:loadState` decodes the complete persisted checkpoint before
reading the next event page. `saveCursor` serializes the complete fold again.
`message-replay-snapshot.mjs` splits string storage into parts but rejoins,
hashes and parses all parts on read. A 200-event limit therefore bounds neither
the checkpoint input nor reducer clone cost. A deadline around these operations
does not interrupt them.

Use normalized **staging** message units and bounded metadata, retaining
`messages_backfill_cursor.state_seq/replay_event_id`. Keep
`applied_seq/applied_event_id/parity_at_seq` as the existing serving
publication/certification boundary. Do not make a second scheduler or ledger.
The prototype demonstrates the storage/reducer contract on one qualified
transition, with publication explicitly pending even at the source head.

`scripts/prototypes/bounded-replay-staging.mjs` is executable under Node 24
against a small SQLite fixture. It uses the real `applyEvent` reducer. It does
not implement or imply a production bootstrap/conversion/publication path.

## Supported unit and structural bounds

One step admits one `message.edited` event addressing one top-level message.
It refuses replies, channel-copy ids, archived metadata, public-page or
public-receipts rooms. Every other family, including message posts, deletes,
redactions and membership changes, remains pending without cursor advance.
These are dependency restrictions on this first experiment, not a new public
event policy. The complete reducer metadata remains available to authorization
and work-evidence checks.

Admission reads UTF-8 sizes from indexed single rows before transferring any
payload into JavaScript. Metadata is at most 65,536 bytes, a staged message
131,072 bytes, and each event 32,768 bytes. The prior anchor event and the next
event are both admitted. At most four payload rows cross that boundary in a
successful step, totalling at most 262,144 payload bytes, plus fixed-size
checksum/control fields. Variable event ids are SQL-filtered to at most 200
UTF-8 bytes; room/message key input sizes are bounded. The next-event query
returns one size/control row, then reads its body only after admission.

All stored scalar controls are admitted inside SQLite before materialization:
`CASE` returns cursor/head/next-event sequence only for integer storage and safe
integer ranges, otherwise NULL. This matters because non-STRICT INTEGER
affinity accepts arbitrarily large TEXT/BLOB values. Format version is also
CASE-guarded. Cursor/event ids must be TEXT of at most 200 UTF-8 bytes; checksum
fields must be TEXT of exactly 64 UTF-8 bytes. Bound room/message lookup keys
are at most 200 UTF-8 bytes. No raw unknown control scalar is returned first
for a later JavaScript type check. SQL size probes return numeric lengths or
NULL, never an unadmitted payload.

Reducer output message and metadata receive the same byte limits before any
write. Their transient allocation is bounded by the admitted inputs and the
existing reducer's bounded edit-history algorithm, not by total room history.
Common reducer upgrades can change metadata even on edits: the experiment
persists updated default channels/work controls instead of discarding them.

No whole-room metadata exemption is allowed. Rooms with overlimit work/member/
channel metadata need a later component decomposition contract; this prototype
refuses them before JSON parsing. Oversized input/output never advances the
cursor. A production adapter must durably record the existing block/pending
reason and allow unrelated rooms to continue; this isolated module has no
fleet scheduler and does not install new block storage.

## Evidence

Run from the worktree using `/Users/johnpotter/.local/bin/node`:

```
node --test tests/bounded-replay-staging-prototype.test.mjs
```

The resource test constructs known synthetic snapshots and staged rows at each
size, then applies the same real edit through full and point contexts. It
does not generate or validate a historical event log containing those initial
messages. Fixture seeding is not a migration or provenance proof.

| Synthetic messages | Existing decoder payload bytes | Snapshot part rows | Point-step payload rows | Point-step payload bytes |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 345,553 | 0 (inline) | 4 | 1,458 |
| 10,000 | 3,459,625 | 6 | 4 | 1,458 |
| 100,000 | 34,689,626 | 58 | 4 | 1,458 |

These are payloads crossing the SQLite/JavaScript boundary, not production
metrics, Worker CPU, billed SQL rows read, disk reads, or timing guarantees.
The census deliberately excludes fixed-size control fields. Query-plan tests
show indexed searches with no scans or temporary ordering for admitted row and
next-event lookups. B-tree traversal still scales with index height.

An executable negative resource control deliberately applies the same
262,144-byte budget to the actual existing decoder:

```
BOUNDED_REPLAY_LEGACY_CONTROL=1 node --test --test-name-pattern='real legacy decoder' tests/bounded-replay-staging-prototype.test.mjs
```

Expected exit 1: `legacy full hydration transfers 345553 bytes; fixed budget is
262144`. Normal tests assert that the legacy input grows while staged point
input remains constant. No failing test is hidden by skipping or a deadline.

The focused suite also covers ten continuously appended edits, closing and
reopening the on-disk SQLite database between every step; same-sequence anchor
body and id tampering; staged-message and metadata checksum corruption;
oversized UTF-8 event input; overlimit metadata/message/output; common reducer
metadata updates; unsupported event families/contexts; source gaps; and an
injected failure after all writes which rolls the message, anchor digest and
existing cursor back together. This is Node/SQLite qualification, not a real
workerd/isolate restart or process-kill experiment.

Root's control-field review produced three fail-before regressions: corrupting
`state_seq`, `rooms.sequence`, or the next event sequence with 2 MiB TEXT caused
each original query to transfer the entire scalar before refusing it. Those
three tests failed on `aae0fe0e6` with `2097152 bytes` observed at the result
boundary. SQL CASE admission fixes them. Expanded controls also cover oversized
cursor/anchor/next ids, format version (with fixture CHECK constraints explicitly
disabled), metadata/event/message checksums; none of those strings crosses the
SQLite/JavaScript result boundary.

Companion dependency qualification compares the real full reducer to the point
context with an existing `m0:channel` sibling and `alsoSendToChannel: true` in
the edit input. `message.edited` updates only the named original; the sibling
remains byte-equivalent, and the complete resulting message rows agree. Actual
post reducer semantics create a channel copy only for a public thread reply;
the original then has `replyToId`, so this prototype refuses it, and it also
refuses direct edits to the `:channel` copy. A second test creates that real
reply/copy pair through `applyEvent` and verifies both refusals preserve rows
and cursor. Redaction has a different companion write set and remains unsupported.

## Proposed schema and writer ownership

The prototype explicitly proposes two tables, rather than hiding new keys in
the existing snapshot string/room-id namespace:

- `message_replay_formats`: one room-scoped v1 format/header row with bounded
  metadata JSON, its checksum, and the last processed event-body checksum.
- `message_replay_units`: `(room_id,message_id)` primary key with one bounded
  full staged reducer record and its checksum.

These checksums reject torn staging and immediate prior-boundary source
tampering. They are self checksums, not independent prospective serving proofs.
They cannot authorize existing legacy rows, detect an adversary rewriting both
payload and checksum, or prove all historical source events unchanged. No
completed certificate is returned. Independent event/projection/write proof
admission and membership coverage remain prerequisites for final publication.

The prototype installation helper exists only as a schema string called by
tests. Before production use, the format requires a v45 writer fence covering
the new tables **and existing cursor/snapshot/event/message/projection owners**.
v44 writers know nothing about this format and can replace snapshots or advance
cursors under incompatible rules; merely marking the new tables additive is
insufficient. Preserve v44 fence definitions, add a new version, refuse unknown
formats on open, and qualify old-source concurrent connection rejection. Root
must coordinate this version with other pending schema work.

Existing runtime ownership needed, after root approval:

1. `message-replay-snapshot.mjs`: explicit format dispatch/read/write/discard;
   retain legacy decoder compatibility but never silently fall back to it for
   an overlimit new-format step.
2. `messages-store.mjs`: bounded event/dependency admission, targeted reducer
   context, transaction-scoped stage/cursor commit and honest existing block
   reporting; preserve applied cursor and all old serving proofs.
3. `writer-fence.mjs` and `store.mjs` migration/schema validation: register new
   schema and v45 atomically. Do not populate it with a whole-room scan in the
   constructor. Existing snapshot remains valid until qualified transition.
4. Backup/export/strict restore schema owners: exact table registration, cold
   reopen, unknown format refusal, interrupted checkpoint restore and old-source
   fixtures. Staging is disposable but cannot disappear while its cursor still
   claims that prefix. Restore may either preserve a coherent pair or reset
   staging progress alone, preserving serving certificates/authority.
5. Privacy/retention owners: account deletion, message redaction/deletion,
   archive/restore, room purge and replay snapshot invalidation must delete or
   rewrite staged sensitive bytes in the same transaction. Include both tables
   in initialize/reset/purge ownership; no stale private copy can survive in
   staging after a privacy rewrite of events/messages/legacy snapshots.

## First production patch boundary and remaining blockers

The next reviewable patch should own the format/schema lifecycle and the
single supported transition first, with runtime routing disabled for every
room lacking a separately qualified prefix. It must include exact restore,
privacy invalidation and real Workers transaction/restart tests before routing
any real cursor to the format. This prototype does not make muse eligible and
does not justify increasing operator conversion limits.

Two broader changes are still mandatory for general large-room recovery:

**Bootstrap and reducer coverage.** A legacy giant JSON snapshot cannot be
converted with a whole `JSON.parse`/`JSON.stringify` and called bounded.
Either consume it through bounded byte slices with a resumable, verified parser
and source digest state, or replay history from an independently valid bounded
prefix into normalized units after qualifying every encountered event family.
Large legacy metadata requires further domain decomposition. Persist parser/
hash continuation if used; retaining an in-memory hash and restarting after
every isolate loss is not a durable continuation. Missing/unqualified prefix
must remain pending. No current-row self-baseline can substitute for provenance.

**Publication.** Existing `publishReplayMessages` scans event changes, maps all
messages, overlays current projection state, validates authoritative rows and
may delete/rebuild a room at once. The prototype never calls it. A follow-up
needs bounded staged validation against independent serving proofs and exact
membership, plus a stable source-version/generation cutover or equivalent
atomic pointer contract. Incrementally replacing live message rows would expose
a mixed fold unless every touched row is proven already equivalent. Continuous
append progress here is not proof that a final coherent cutover can finish
under arbitrary writes. Archived-content parity must compare content, not just
counts, before archived rooms can become eligible. Root review is required
before selecting that larger schema/authority change.
