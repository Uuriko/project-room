# Attachment lifecycle review follow-up

Grok G5 was read and reconciled against the existing room permission model.

## Implemented

- Copy the exact byte view before hashing; persist that same copy. A real worker
  thread mutates a SharedArrayBuffer throughout the regression test. Every staged
  file remains readable with its stored digest; no claim is made that concurrently
  written input represents a coherent producer snapshot before copying.
- Reclaim staged bytes atomically when a room member is deactivated or an account
  is retired. Sponsored managed-agent uploads are included. Retained tombstones
  prevent old retries from restoring bytes. This does not delete committed files
  (that state is not implemented yet).
- Preserve staged-content privacy: owner authority does not grant read access to
  another uploader's unposted bytes. Retirement performs cleanup without a read.
- Verify the ownership index at startup/audit, and derive the schema byte cap from
  the shared limit rather than duplicating a numeric literal.

13 focused Node tests pass, including retirement rollback, sponsor retirement,
missing-index refusal and concurrent shared-memory mutation. The shared Worker
adapter staging test also passes. Worker retirement-specific cases and a full
post-follow-up suite remain required; the preceding schema candidate's 1,188-test
pass is recorded separately and is not presented as testing these later changes.

## Review decisions and remaining scope

Active guests can post messages under the existing shared contract; no invented
permission bit was added just for staging. Upload limits/abuse controls remain
required at the HTTP boundary. HTML/SVG may be file contents, but must not be
executed as same-origin previews. MIME rejection is not malware protection.
Private-read 404 and exact-owner-retry 410 deliberately expose different amounts
of information; they are not collapsed into an existence-revealing read response.

The 4,096 lifetime-row ceiling remains a temporary fail-closed pilot limitation,
not an acceptable final retention policy. Safe receipt compaction, room/member
quota boundary tests, expiration cleanup, inactive-upload backfill, committed
attachment deletion/audit, and the full HTTP/UI journey remain open. No deployment
or canonical edits occurred. Grok G6 is reviewing exact schema commit `e273a7b`.
