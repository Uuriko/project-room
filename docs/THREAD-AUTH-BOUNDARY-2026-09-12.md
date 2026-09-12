# Thread read policy checkpoint

Isolated branch `codex/project-room-identity-scope`, parent `1031c57`.
Canonical HTTP/MCP edits remain untouched. No deploy or integration.

## Reproduction and change

Two HTTP regressions failed on the parent:

- A durable room key placed in `room_session` received thread content (200),
  although room routes require a real browser session in that cookie.
- After 600 alternating event/thread reads, another thread read still returned
  200; the early thread return bypassed the credential's common read limiter.

Thread routing now proceeds through the common room authentication, credential
scope, browser-session-kind and read-rate checks before calling the thread store.
Room/message path IDs use the same decoder/validator as other routes. The early
parallel authentication branch was removed rather than duplicated.

## Verification

Nine focused tests passed. The two new regressions now observe 401 and 429,
respectively, with no thread content on cookie misuse and Retry-After on quota
exhaustion. A valid room Bearer still returns the thread. Existing nested-reply,
unknown-message, anonymous denial and diagnostic tests pass; diagnostic routes
redact the message ID. `git diff --check` passed.

`node scripts/check.mjs`: 1,159 passed, zero failed/cancelled/skipped;
test duration 44,781 ms.

## Remaining qualification

This closes the reproduced thread entry-point bypass, not every identity/session
case. More cross-route matrix coverage is still appropriate for account sessions,
guest agents, revoked credentials, expiry and runtime parity. Read limits are
process-local, not a distributed enterprise quota. Recovery/import authority and
release provenance remain independent high-priority audit findings.
