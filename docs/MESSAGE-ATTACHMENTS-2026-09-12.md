# Atomic message attachments

Schema 29 adds committed/deleted attachment states and a message identity.
RoomStore message commands may select up to four unique, owned, unexpired staged
upload IDs with an explicit message ID. The server supplies immutable metadata;
clients cannot inject attachment names, types or hashes into message events.

Commitment and the message event share one database transaction. A failed message
or unavailable selected file rolls back every attachment change. The event stores
metadata but no bytes; the room projection preserves it for clients and replay.
An exact message retry resolves through the existing command receipt before any
attachment side effects. A different message cannot reuse a committed upload.

The service-level committed read checks current room access, the message reference,
live state, length and digest. Staged uploads remain private. Message deletion
removes live bytes and preserves the deleted file record; retrying the original
send cannot restore them. This is not secure erasure of previously downloaded
copies or backups. Independent file deletion is not implemented yet.

Recovery checks message-to-file and file-to-message references, ownership,
metadata equality and deleted state. Missing storage records fail audit. Staged
rows omit an absent message identity in the logical recovery digest so the new
nullable field does not pretend old staged content changed during migration.

## Migration and tests

The version-28 table is verified and copied transactionally into the new schema.
Older writers are fenced. Pre-29 event histories containing previously reserved
attachment fields fail for reconciliation instead of reinterpreting old data.

- 49 focused attachment/conversation/recovery/provenance tests passed before the
  last additional missing-file audit assertion.
- Final attachment suite: 15 tests passed, including that assertion.
- Genuine version-28 Node upgrade passed: byte-bearing records, rollback and old
  writer refusal. Genuine Worker upgrade passed, including restart.
- The Worker upgrade fixture now transports binary fixture values explicitly;
  ordinary JSON object serialization had broken BLOB seeding. It compares the
  original columns so adding a nullable field does not invalidate preservation.
- Full regression on unchanged6f0003f finished:1195 passed,0failed/skip,
  87,859ms. This qualifies that checkpoint, not later HTTP changes.

## Still required

No HTTP routes, downloads in the UI or composer file controls are exposed yet.
Messages currently require caption text. File-only messages, bounded authenticated
streaming uploads, safe download headers, quotas/cleanup, file deletion controls,
and end-to-end browser/device tests remain part of the required journey.
The pilot lifetime-record cap and versioned expiry policy still need refinement.
G6's previously reported missing-index issue was fixed in the prior lifecycle
commit; no claim is made that a deleted payload can be verified from absent bytes.
No deploy, publication, external storage or canonical source edits occurred.
