# Verified download client checkpoint

RoomClient.downloadAttachment now reads committed files using same-origin
credentials and the captured session binding. Account mode requires current
account ownership. No access token appears in a URL.

Before returning a Blob, the client checks the reference's bounded size, reads
at most that many bytes, verifies exact length and SHA-256, then checks session
ownership again. The Blob type is application/octet-stream, regardless of the
uploaded MIME type. The interface must save it, not embed it as active content.

User cancellation, disconnection and a10second deadline abort the request.
Changing rooms/accounts prevents a late response from producing a download.
Network errors never display server-supplied markup. This is integrity checking,
not malware detection or proof that opening a file is safe.

## Evidence

30/30 focused attachment-client, client and client-stream tests passed. Seven
new tests cover exact bytes/bound headers, size/hash mismatch, streamed overflow
cancellation, late identity replacement, user/disconnect abort, invalid references,
stale account ownership, empty files and inert error messages. These are client
unit tests, not browser/device journey proof.

HTTP source remains unchanged from02fba88 for Grok G7 review. That exact baseline
passed1200/1200 full regressions and2 Worker checks. Later client code has not yet
received the full regression/browser gate.

## Remaining user-facing work

Download buttons must use this verified path and recheck their current UI context
before triggering a save. Composer selection, staging, cancellation/retry,
thread-scoped draft ownership, unknown-commit recovery and file-only messages
remain open. No download button or upload control is exposed by this checkpoint.
Agent/OpenAPI declarations also remain unchanged. No deployment occurred.

## Upload client follow-up

RoomClient.uploadAttachment(id, File, { signal }) now sends bounded raw bytes,
with Origin supplied naturally by the browser and current CSRF/session-binding
headers. It verifies the returned ID, room, uploader, filename, MIME, size,
checksum, state and timestamp shape before returning a successful receipt.
Receipt reads are capped at4096bytes. Oversize files are rejected before reading
their contents. Cancellation/disconnection and a10second deadline abort transfer;
late receipts cannot enter a replacement room/account context.

The caller owns the stable upload ID. There is no automatic retry or message
publication. Cancellation or transport failure does not claim that the server
discarded bytes: a completed staging write may have outlived the response.
Retrying the same ID and same file resolves that uncertainty idempotently.

31/31 focused upload/download/general client checks passed, including six new
upload tests. The real HTTP test deliberately loses a successful response, proves
one staged record exists, retries twice, and proves the record is not duplicated
and no message was posted. Receipt mismatch, streamed oversize, pre-cancel,
oversize input and late room replacement are also covered.

Composer integration still needs to retain the ID with its File, provide explicit
retry/remove controls, prevent send until uploads are verified, and bind files to
the correct thread-scoped draft. No visible upload control is added in this step.
