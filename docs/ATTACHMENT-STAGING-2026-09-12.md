# Attachment staging implementation checkpoint

Historical checkpoint at `b1ec4f0`. Startup/schema integration is continued in
[Attachment schema integration](ATTACHMENT-SCHEMA-2026-09-12.md); the limits
below describe the earlier staging-only checkpoint.

Implemented `server/attachments.mjs`: room/uploader-owned staging, immutable
upload identity, byte digest, expiry, discard tombstones and bounded capacity.
This module is **not wired into application startup or HTTP**. Its schema is
created only inside disposable tests pending versioned migration, writer fences
and recovery integration. This checkpoint does not claim usable file sharing.

## Behavior implemented

- Current room authentication and optional browser-session binding are checked
  inside the shared transaction boundary, including exact retries.
- A staging ID may be retried only with the same uploader/name/type/bytes.
  Discarded or expired IDs cannot restore content.
- Staged bytes are private to the uploader, not visible to other room members.
  Reads verify both byte count and digest; corruption is not served.
- Explicit discard removes live bytes and retains metadata/state. Expiry denies
  reads immediately; later successful staging writes reclaim expired bytes.
  Reads never perform cleanup writes.
- Limits: 1 MiB/file, 8 MiB/member, 16 MiB/room, 32 staged/member and 4,096 total
  records/room. These are provisional pilot limits, not enterprise scale claims.
  Tombstones count toward the total record limit; exhaustion intentionally fails
  closed until a qualified retention/compaction policy exists.
- Path separators, controls/bidi overrides, oversized names and malformed media
  types are rejected. Filenames and MIME types still require safe HTTP rendering;
  accepting a type does not establish malware safety.

## Verification

`node --test tests/attachment-staging.test.js`: **8 passed**, zero skips/failures.
Checks include ownership, cross-room absence, exact/mismatched retries, discard,
expiry, member-byte capacity, zero-byte count limits, malformed names, revoked
membership, session-binding mismatch, outer rollback, slice isolation and stored
byte corruption. Aggregate room and lifetime-record limits still need independent
boundary tests, along with concurrent HTTP requests once that route exists.

`cd cloudflare && node --test attachment-staging.check.mjs`: **1 passed**, zero
skips/failures. The bundled implementation uses the actual RoomStore and
DurableDatabase adapter, testing slices, retry conflict, nested rollback, a
1 MiB file and discard. The native primitive restart tests from the preceding
checkpoint remain separate; this test does not claim full migrated-store restart.

Initial staging tests found Node rejects raw ArrayBuffer SQL parameters. The
implementation now copies the exact input view and binds a Uint8Array on Node
or that copy's ArrayBuffer on Durable SQLite. Both paths were exercised afterward.

## Required next integration

1. Reconcile Grok G5 review and strengthen quota/validation boundary coverage.
2. Add the versioned application migration, old-writer fences, schema verification,
   attachment integrity/metadata lifecycle audit and runtime packaging together.
3. Atomically bind immutable attachment references when a message is accepted;
   implement authorized shared download and audited deletion of committed files.
4. Bound/authenticate HTTP upload streams before allocation, handle revoked access
   at commit, enforce CSRF/rates and safe non-inline download headers.
5. Add composer selection/progress/remove/retry and complete desktop/mobile,
   keyboard, lost-response and revoked-access journeys.

No canonical edits, deployment, provisioning, publication or real uploads occurred.
