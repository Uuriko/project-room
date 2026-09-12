# Room attachments: implementation contract

Status: **not implemented**. This is a staged build specification, not a shipped
capability, approval to provision storage, or a replacement for the product goal.

## Current evidence

At `4e64dfc`, room messages have no attachment field or file persistence route.
`server/http.mjs` uses attachment Content-Disposition only for exports.
`server/email-envelope.mjs` and `server/graph-email.mjs` normalize email
attachment descriptors; `src/inbox-ui.js` explicitly says files are unavailable.
They must not be repurposed as a room file-sharing implementation.

The room store uses synchronous transactions and schema version 27.
`server/writer-fence.mjs` identifies the application tables and old-writer guards.
`cloudflare/storage.mjs` provides the Durable Object adapter and its own version
fences. `server/recovery.mjs` checks an exact table inventory and data integrity.
Consequently, an unversioned side table or local-filesystem-only upload handler
would bypass important existing lifecycle assumptions.

## Required small-team journey

1. Select or paste a file into the composer; show its name, size and Remove.
   Upload progress is distinct from message delivery. Cancelling before send
   never publishes a message. Preserve text when upload fails.
2. Send one message with immutable file references. A lost response retries the
   original operation, not a second file or message. Do not expose an upload in
   room history until the message transaction accepts its references.
3. Other currently authorized room members can download the exact bytes. Names
   are escaped text, not HTML or filesystem paths. Downloads require current
   room authorization; possession of the URL is never sufficient.
4. Leaving, removal, key rotation and session expiry affect downloads under the
   same rules as room reads. Bytes already downloaded cannot be recalled; say
   so in deletion/retention documentation rather than promising revocation.
5. A sender or authorized moderator can remove a file, with a durable audit
   tombstone and a clear unavailable state in history. Backups and retention
   must have an explicit policy; deleting live bytes is not erasing all copies.

## Storage implementation sequence

### A. Qualify the storage boundary before a schema change

Exercise binary round trips, transaction rollback and memory bounds against both
the Node SQLite interface and the existing local Durable Object test runtime.
Compare a bounded in-database payload with a metadata-plus-object-store design.
Do not add a service or credentials merely to satisfy this comparison. Decide
from measured limits and deployment constraints, not generic assumptions about
SQLite or Worker limits. A preliminary 1 MiB per-file test cap is a proposed
pilot constraint, not an enterprise target or a verified platform maximum.

### B. Persist staged uploads and lifecycle receipts

Use explicit ownership (room, uploader, upload ID), byte length, content digest,
display filename, declared type, created time and lifecycle state. Names must
never select a path. Unreferenced uploads have a bounded expiry and room/member
quotas, including concurrent requests. Use a transactional compare-and-set for
attachment commitment and deletion. Reusing an upload ID with different bytes
or metadata is a conflict; an exact retry returns the original receipt.

Any schema addition must update migration, Node/Worker old-writer fencing,
recovery table inventory, integrity verification and runtime packaging together.
Do not copy the earlier additive invite-table exception without proving it is
safe for file deletion, quota, replay and recovery semantics.

### C. Integrate message commands and authenticated HTTP

Add bounded attachment references to the shared message command and reducer.
Validate room ownership, staged state and uploader authority inside the same
transaction that commits the message. Agents use the same scope and quotas.
No raw bytes in the event log, search index, public discovery or diagnostics.

Authenticate upload before reading its body, bound bytes while reading even
without Content-Length, then revalidate access when committing. Use the existing
room credential selection, browser session fence, CSRF and rate-limit paths.
Download must recheck access and lifecycle state. Return no-store, nosniff and
attachment disposition with a safely encoded filename. Initially offer download,
not active-content previews; never trust a declared MIME type as malware safety.
Scanning and sandboxed previews remain explicit additional requirements.

### D. Complete the UI and operational qualification

Use one attachment affordance, keyboard-accessible selection/removal, an announced
failure state and an explicit retry. Do not introduce an empty Files destination
before browsing/reuse needs it. Verify mobile selection and download on physical
devices in addition to simulated browser tests.

## Required adversarial and journey checks

- Byte limit with honest, missing, false and oversized Content-Length; bounded
  parallel uploads and staged-upload expiry; abort with no committed message.
- Cross-room reference/download, unauthorized upload, revoked/expired sessions,
  missing CSRF, access loss between body read and commit, agent scope denial.
- HTML/SVG/script payload, MIME mismatch, control characters, Unicode/bidi names,
  path traversal names and Content-Disposition injection without content execution.
- Exact versus mismatched retry; lost response after commit; duplicate attach,
  delete retry, concurrent deletion/read and message failure rollback.
- Restart and schema upgrade with prior open writers; Node and Worker parity;
  backup completeness, missing/corrupt bytes and deletion tombstones in recovery.
- Composer text preservation, file removal, screen-reader names/status, keyboard
  focus, long names, narrow layouts and stale responses after session replacement.

Done means the upload-to-download-and-delete journey is integrated and qualified,
not merely that a parser, table or upload endpoint exists. Hosted rollout and
external services still require owner authorization. Grok's independent G4 review
is pending and must be reconciled with this contract before implementation claims.
