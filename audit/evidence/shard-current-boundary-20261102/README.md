# Normalized shard safety boundary

Runtime `f7fdadc8472cc0183bda58fa20782fbe0206ef93`, causal red `296f864b9`, base `26ae96268`. Isolated worktree `pr-shard-current-copy-1102`. No production calls, data changes, publication or deployment.

This is the immediate safety correction approved by root, **not completed normalized shard transfer**. The optional sharding path remains default-off. Legacy room copy and strict room backup/restore remain functional.

## Defect and correction

The new normalized records, proofs and head were unclassified. Three fresh target-local tables were called skipped even though each destination creates them. Classification now distinguishes:

- `current_room_head`, `current_room_records`, `current_room_record_proofs`: room data, keyed by room_id.
- `current_restore_admission`, `current_restore_audit_scratch`, `current_room_writer_permit`: target-local controls. They are neither directory authority nor imported room data.

Placement classification does not authorize copying protected records. The legacy copy helper omitted the current relations and could copy only a closed normalized carrier. Its event/message/projection-size comparison could also report equality while ignoring normalized state. Simply adding current tables would still omit immutable operator receipt evidence and violate exact current mutation guards.

The legacy helpers now refuse a source **or destination** containing current room heads, records or proofs, or a closed carrier marker. Copy refuses before entering a destination transaction. Export refuses before constructing the slice; comparison/digest refuses rather than reporting a misleading match. A supplied slice with current records or a normalized carrier refuses before replay creates its destination file. Directory tables and unknown tables still fail the existing strict replay policy. No exact writer guard is dropped or bypassed, and no credentials, grants, receipts or source permits are copied.

## Qualification

The12 existing named tests reproduce9 passing and3 failing on base26ae: native-agent recovery classification, fresh shard classification and legacy room slice backup. The first6 new boundary tests all fail on that baseline. Final affected scope is20/20 passing, including legacy repeated copy, drift correction, strict backup roundtrip, unknown/directory rejection, native OAuth directory authority, normalized source/target refusal, raw slice refusal before file creation, unchanged entire source/destination tables, closed-marker refusal and misleading comparison refusal.

The actual Cloudflare `RoomShard` constructor is qualified in a new synthetic fetch fixture with flag0 and1. Flag0 leaves its Store unopened. With flag1, a real normalized room is initialized locally; copy/export/compare refuse, no destination transaction runs, observed rowsWritten=0 with0 unknown write samples, and independent normalized audit state plus exact local restore control remain unchanged. This is not a cross-object normalized copy or public shard endpoint qualification. Production RoomShard.fetch remains404.

Targeted lint has0 errors and0 warnings. Compressed logs and exact hashes are listed in results.json. No broad unchanged suite was repeated.

## Open requirement and MVP choice

A real normalized room transfer requires a larger, explicit contract: a consistent per-room source manifest; exact closure of referenced immutable operator receipts and historical checkpoint evidence; target-owned existing restore admission/continuations; exact-format scoped loading; independent census/replay/engine checks; and rejection of credentials, grants, unrelated audit rows and source control state. The existing copier uses whole-room `.all()` and one synchronous transaction, so it is not a bounded normalized migration path. This requirement remains open.

Proposed product simplification, not an accepted scope change: keep the primary normalized store and leave `ROOM_PER_ROOM_OBJECTS` off while evaluating whether normalized shard transfer belongs in the MVP. The normalized transfer and scaling requirements remain open; these refusal tests do not fulfill them. No user command currently invokes this copier. A later removal can eliminate inactive shard routing/configuration from the product build, but root should first reconcile deployed Durable Object class/binding/migration ownership; this patch does not inspect live namespaces or delete registrations. Do not build a second migration system merely to keep dormant sharding nominally supported while primary recovery is being completed.
