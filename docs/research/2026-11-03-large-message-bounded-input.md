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
