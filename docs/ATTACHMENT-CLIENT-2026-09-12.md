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
