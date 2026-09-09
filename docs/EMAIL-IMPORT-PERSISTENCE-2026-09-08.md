# Durable private email import

## Implemented scope

Schema 18 introduced an account-owned, fixture-backed email import journal, connection state and folder checkpoints. Schema 19 adds a per-message revision guard and retires older writers that do not enforce it. Imported message versions and private drafts reuse the existing Inbox tables. This is not a live provider connection: configuration is explicitly `mode: fixture`, has no credentials or sending capability, and is not exposed as a public HTTP setup/import endpoint.

The service entry is `store.email`; `server/email-import.mjs` owns its transitions. Ordinary Inbox commands cannot record `source.import`, change a source's channel origin or send imported email through the synthetic transport. The browser explicitly negotiates `view=email-text-v1` for email list/detail support and private drafting; requests without that view retain the synthetic-only list. Authorized service callers can still read the stored envelope using the same private account boundary. Browser email sharing and sending remain unavailable.

## Connection and source lifetime

Connection configuration binds an account, stable connection ID, provider/mailbox identity, positive revision, sending identity and known aliases. One account cannot create two connection IDs for the same mailbox. Reconfiguring a connection cannot silently replace its mailbox; it increments the revision. Disconnect increments that revision and stops new imports. Stored private mail and drafts remain readable by the authenticated owning account.

The account's authorization epoch is also captured. Re-enabling an account does not resurrect a former import grant. The service reports `canImport: false` until the user configures the connection again. Every apply/read authenticates the account independently of room membership; an agent's room credential supplies no mailbox access.

Importer observations bind the exact current connection profile and folder. Content identity comes from the normalized envelope contract. Unchanged observations do not create another Inbox source revision. Changed observations create a new immutable source version while keeping an existing draft pinned to its original source revision. Nothing is silently rewritten or sent.

## Atomic sync and resync

Each page includes a stable request ID, expected folder revision, expected cursor, current connection revision, next cursor, completion flag and bounded hydrated/absent observations. The source imports, folder checkpoint and import receipt commit together. If any write fails, all roll back. An exact retry returns the original receipt; a different body under the same ID fails. A competing page cannot advance a checkpoint it no longer owns.

Initial connection and reconnect require a full scan. Full-scan membership is accumulated separately while the old completed membership view remains available; only the completed scan replaces that folder's membership set. Explicit reset supports an expired cursor. Subsequent delta pages apply folder membership changes without inventing a mailbox-wide deletion. No absence, folder move or completed-scan omission deletes a source or draft.

Every new hydrated observation must include `expectedSourceRevision`, captured before fetching that message. Folder checkpoints alone cannot stop a late response from folder A overwriting a newer observation already imported through folder B. A source conflict rolls back the whole page. The driver must fetch the message again, not merely update the revision on an old payload. Historical schema-18 requests remain replayable and can retrieve their exact existing receipts under current authority; new requests without the source revision are rejected.

Folder cursors remain private opaque data and this code never fetches them. A future driver must validate origin/path before using credentials, hydrate incomplete provider observations, coalesce repeated invalidations, verify attachment/body version consistency, and choose reset only after an established provider outcome. A folder scan does not establish coverage of every mailbox folder.

Limits currently bound a page to 50 observations, a folder membership set to 1,000 IDs, account connections to 20, request data to the envelope's 2 MiB input bound, and each account's import journal to 5,000 commands/16 MiB of request bytes. Existing Inbox source/version/draft limits also apply. Exact retries and disconnect remain available at the import-journal limit. These are fixture-pilot bounds, not a large-mailbox performance qualification or final retention policy.

## Replay, migration and packaging

The same deterministic transition produces live mutations and replay expectations. Opening a store verifies the import journal against connection/folder projections and exact Inbox import receipts. Orphan importer writes and unjournaled projection changes require reconciliation. The existing Inbox verifier independently checks message versions, drafts and their receipts. Offline recovery compares all 27 application tables and treats changed email connection records as access differences; it never authorizes reopening on its own.

Schema-19 write guards cover old and new tables. Genuine older packages, including populated schema-18 email data, are used in upgrade tests. A failed migration must leave their catalog/data unchanged, and successful upgrade must retire their already-open writers. Both Node and local Workers retain the shared service semantics. Runtime packaging includes the new envelope/import dependencies so a cold recovery does not depend on checkout files.

## Browser reader and next steps

The negotiated browser view provides bounded plain text, a sample/private label, collapsed recipient details and attachment availability in the existing Inbox. Private drafts survive reload and disconnection; metadata-only refreshes do not invent draft conflicts. HTML content is omitted with an unavailable-preview notice, and attachment bytes are not offered. See [the reader checkpoint](EMAIL-READER-CHECKPOINT-2026-09-08.md).

Next, qualify deliberate plain-text excerpt sharing and the reviewed return path. Sharing is not enabled by this reader change. HTML requires a separate inert/sanitized rendering and selection contract, not regex flattening. Do not automatically include headers, Bcc, attachment descriptors or later messages in shared excerpts.

An offline recorded-fixture driver now exists; its scope is recorded in [the Graph fixture checkpoint](GRAPH-FIXTURE-SYNC-2026-09-08.md). A live provider step still requires an explicitly authorized dedicated mailbox. Real OAuth and secret storage, background grants, HTML/media handling, attachment bytes, deletion/retention, real sending and provider reconciliation remain incomplete. No live compatibility or delivery claim follows from these local tests.

## Verification

Candidate and final test outcomes are recorded at the committed checkpoint. Tests include exact retry, unchanged observation, draft preservation, concurrent readers/writers, reset/full-scan continuation, moves/absence, account and connection revocation, quota recovery, journal rollback, tamper detection, populated backup, cold package reopen, offline access-difference reporting and local Workers restart. Browser tests continue to use simulated people; provider payloads are invented fixtures.
