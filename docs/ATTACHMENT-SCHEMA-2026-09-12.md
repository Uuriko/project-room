# Attachment schema and recovery integration

Attachment staging now belongs to RoomStore startup under schema **28**. HTTP,
message commitment and the composer are not implemented yet; no public file
sharing capability is claimed.

## Changes

- Startup creates and verifies the exact attachment table in the migration
  transaction; read-only startup verifies it without creating or repairing it.
- Version-28 writer guards include attachments and previously additive agent
  invitation codes. Older ordinary service writers cannot mutate the upgraded
  database. These guards do not protect against a database administrator.
- Recovery includes the new table and validates ownership references, metadata,
  byte lengths and content digests. It reads payloads one at a time and uses
  verified length/digest summaries in its aggregate report, not raw bytes.
- The recovery fixture includes substantive attachment data; backup/reopen tests
  now account for all 31 application tables.
- Exact runtime packaging includes the attachment module and schema 28. A cold
  candidate process stages and reads a file through its packaged RoomStore.
- Migration assertions compare every table actually present in each historical
  runtime instead of excluding a fixed list of recently added tables. Existing
  synthetic downgrade fixtures remove attachments before claiming old schemas.

## Verification so far

- 25 focused staging/recovery/writer tests passed.
- 52 related service/invitation/producer/session tests passed after schema
  expectation updates.
- Genuine version-27 Node upgrade: passed, including injected rollback and old
  writer refusal. The baseline is committed `b1ec4f0c0b72f2a6967acdec33345ae713c1b53e`.
- Genuine version-27 Worker upgrade: passed, including permit replacement,
  injected rollback, old writer refusal and restart.
- Shared Worker staging test passed using the startup-created table.
- Both cold package tests passed; the strengthened attachment stage/read cold
  assertion subsequently passed in its focused rerun.

The first broad check was started before final test-expectation and cold-test
corrections. Do not treat it as an unchanged-candidate release gate; record its
outcome separately and repeat a final exact-state check before release claims.

## Open work

Grok's G5 independent staging review remains pending. Aggregate room and lifetime
record-limit tests, stronger filename validation and concurrent request tests
still need review. This does not resolve the larger offline restore/authority
freshness problem: a verified capture cannot prove there were no later revocations.

Next implement immutable message-file commitment and lifecycle auditing, then
bounded authenticated upload/download/delete routes and the complete composer
journey. Staged file expiry is not yet a background cleanup service. No external
storage, public MCP upload, deployment, publication or canonical edits occurred.
