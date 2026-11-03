# Bounded canonical message input (#5759)

This source supersedes the temporary 8192-unit producer mitigation; it is not a
statement about deployment. Historical replay and new bodies retain the existing
65536 UTF-16-unit limit. No journal, schema, writer format, or permissions change.

The old 128KiB limit counted the current body twice (raw text and record JSON)
plus retained edits. A valid maximum ASCII row already occupied 131256 bytes;
CJK and escaped control bodies occupied more. Thus accepted messages could fail
selected cold reads and their edit/delete/reply dependencies.

The reader now reserves **one cumulative 917504-byte canonical message pool** per
existing current read scope:

- raw body: at most 3 × 65536 UTF-8 bytes;
- duplicate JSON body: at most 6 × 65536 bytes;
- original bounded edit-history bodies: at most 6 × 32768 bytes;
- nonbody proof fields and metadata: at most 131072 bytes.

The existing 256KiB metadata budget and record limits remain. Small rows retain
original accounting; large rows charge metadata there and every raw proof-field
byte to the shared message pool. Dependencies cannot obtain another pool.
Scalar cell lengths and JSON geometry admit large payloads before loading them.
Exact UTF-16 lengths and the original 25-entry/20000-per-body/32768-total history
policy are checked after decoding; conservative byte geometry is not an exact
UTF-16 count. New prepared rows use the same limits before persistence. Original
hash recomputation and independent witness/sequence checks remain mandatory.

Maximum escaped current body plus retained history passes selected conversation
output under its unchanged 512KiB cap: that response omits editHistory. The
separate thread endpoint still refuses a response above 65536 bytes with explicit
413 `current_thread_too_large`; selected conversation remains available. No output
cap or private-message/history-floor rule was raised.

Actual production Native checks exercise maximum ASCII/CJK/control/astral
historical and new messages: cold read, reply dependency, edit, exact retry,
delete and cold reopen, nonparty and prejoin refusal, scalar,
hash and missing-witness tamper rejection. Node controls additionally prove full-edit transaction fault rollback. For control-body selected reads with
1k versus 5k unrelated messages: 119 SQL statements, 959 physical rows read,
zero writes, SQL text 14794 bytes and bindings 4159 bytes in each case. Serialized
SQL returned JSON was 1166605 versus 1135420 bytes; this includes JSON escaping
and is a different metric from raw proof-field reservation. No flat returned-byte
or production latency claim follows from these local runs.

Automatic rollback also pins the exact canonical-reader Git blob. A same-floor
older reader may not read rows admitted by this one. Missing proof refuses only
automatic rollback; existing explicit manual authorization remains unchanged.

## Existing-row size census

`node scripts/audit-current-message-input.mjs DATABASE [ROOM_ID] [CURSOR_JSON]`
opens SQLite read-only, loads no RoomStore, runs no migration, and returns one
indexed page of at most 20 scalar rows. It emits size-class counts and an opaque-
to-content keyset continuation, never body text. Continue until complete; a full
page can legitimately point to an empty next page. It does not establish entity
hash, witness, history shape or exact UTF-16 validity, and is not a whole-database
aggregate or a repair command.

For an authenticated Cloudflare Data Studio SELECT-only check, use the exact SQL
returned by `messageInputPageSql({selectedRoom:true})` in that script. Bind a room,
last message ID (empty initially), and limit 20. The optional unselected variant
uses `(room_id,message_id)` keyset ordering. Both select only byte lengths and
keys, plus existence of the protected room namespace; do not select raw cells.
Above-derived-ceiling rows remain explicit refusals requiring investigation;
this patch neither deletes nor silently truncates existing data.

Local logs: `/tmp/current-large-message-input-live-1103.log`,
`/tmp/current-large-message-input-native-live-1103.log`,
`/tmp/current-large-message-neighbors-1103.log`,
`/tmp/current-large-message-guard-1103.log`, and
`/tmp/current-large-message-final-small-1103.log`.

Generate the exact selected-room Data Studio SQL without opening a database:

```sh
node --input-type=module -e "import {messageInputPageSql} from './scripts/audit-current-message-input.mjs'; console.log(messageInputPageSql({selectedRoom:true}))"
```

## Reply ancestry composition

Independent review found the first repair still rejected a short C after maximum
A → maximum B → C, and could not edit/delete B. Those were three real normal-
command failures, not invalid input. Ancestor text is irrelevant to these checks.
The existing protected messageWitness now also records exact scalar headers
(identity, sequence, channel/root/reply links, parties, work link, dates) during
initialization and qualified writes. Command ancestry compares addressed scalar
headers and entity-hash identity with that protected header. It does not pretend
to validate an unneeded ancestor body from the scalar hash. Actual selected,
edited, deleted and evidence messages retain full body/hash/witness verification.

Header-only dependencies are private internal context. Before persistence, any
reducer mutation or affected-message selection of one refuses; ancestors are
never written as message stubs. DM ancestry, root channel and request ancestry
checks still see all headers. Header changes, hash changes, missing witnesses,
and full-body tampering remain covered by their respective qualified readers.

Existing hash-only witnesses are not rewritten by reads. They fall back to full
verification of at most 32 ancestor entities, one at a time, retaining only the
header. ALL raw field bytes count cumulatively against a separate **29360128-byte
ancestry-work ceiling** (32 × 917504), with the SAME metadata/record/receipt
budget. The selected-body pool stays 917504 bytes. This compatibility fallback
can be expensive; it is not a constant-small byte claim or a free fresh ancestor
budget. New witnesses avoid ancestor body transfer. No history scan, table,
schema upgrade, readonly proof write or grant is introduced.

Actual Native qualification includes a genuine detached `9e6beac42` producer
initializing old hash-only witnesses, then cold reopening that same persisted
Durable Object with the new runtime before C/editB/deleteB and a second cold
read. The optional local qualification source is explicit:

```sh
ROOM_MESSAGE_OLD_SOURCE=/tmp/pr-large-message-before-1103 node --test cloudflare/current-large-message-input.check.mjs
```

The default check always exercises new headers; the supplied old source adds
the genuine old-witness case, and diagnostics distinguish both. It creates no
runtime dependency on a historical Git SHA. The before control is retained in
`/tmp/current-message-ancestry-before-1103.log` (three failures).
