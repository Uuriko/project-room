# Attachment transfer checkpoint

Local implementation in the isolated integration tree; no deployment or public
availability claim. Builds on schema29 atomic message attachments.

## Contract

`/api/rooms/:roomId/attachments/:id` now supports:

- PUT: raw bytes, percent-encoded UTF-8 `X-File-Name`, syntactically valid
  lowercase MIME in `Content-Type` (defaults to application/octet-stream).
  Returns200 with staging receipt; exact retries remain idempotent.
- GET/HEAD: committed, undeleted message files only, to current room members.
  Staged bytes are not exposed by these routes.
- DELETE: discard one's staged upload; committed files must be removed through
  their message's revision-checked deletion command.

Common room authentication, bearer restrictions, browser Origin/CSRF/session
checks and rate limits apply. Upload completion reauthenticates using the binding
captured before reading the body. Revocation during transfer cannot persist bytes.
No credentials or filenames belong in URLs. Unknown query selectors are rejected.

## Resource and rendering boundaries

Uploads accept at most1MiB, checked against declared length and streamed bytes.
Compressed request encodings are rejected. In-flight admission is limited to4
per server,2 per room and1 per member per room. A10second deadline terminates slow
uploads. Oversized request bodies drain without retaining chunks and keep their
admission slot until end/close/deadline. Existing storage quotas still apply.

Downloads use application/octet-stream, attachment Content-Disposition with an
encoded original filename, sandbox/default-src-none CSP, no-store and nosniff.
These prevent inline execution in the Room origin; they are not malware scanning
or a promise that opening a downloaded file is safe. Diagnostics redact item IDs
and query strings. No new runtime module was introduced.

## Verified evidence

- Node:22/22 attachment storage/HTTP/thread authorization tests passed.
  HTTP coverage includes exact retries, private staging, message commitment,
  byte-exact downloads/HEAD, safe headers, deletion, room isolation, cookie
  credential misuse, CSRF, valid browser upload/discard, malformed metadata,
  compressed bodies, known-length/chunked oversize, member admission,
  mid-upload revocation and interrupted upload non-persistence.
- Worker:2/2 real local runtime tests passed, covering shared storage and the
  actual Node HTTP bridge. Transfer round trip included exactly1MiB and an
  oversize rejection. No deployed Worker was accessed.
- Prior unchanged6f0003f baseline:1195/1195 full regression passed.
  Exact02fba88 HTTP candidate full regression subsequently passed1200/1200,
  0failed/skip,73733ms. Later client changes are separately qualified.

## Independent review and next implementation

G7 should independently test per-room/global admission, slow deadline cleanup,
account-session rebind during transfer, method/selector handling and aborted
transport behavior. Current tests do not prove every concurrency or timeout case.
Grok must use a new test file outside this isolated tree, not edit source.

Next: concise composer file controls, upload progress/cancel/retry, file-only
messages, authenticated download UI and browser journey evidence. OpenAPI and
agent capability contracts need explicit updates before advertising attachments.
Public MCP remains a gated no-files preview. Larger-file storage, malware policy,
retention/expiry evolution and real-device qualification remain open.
