# Pending Inbox operations — September 19, 2026

## Reproduced and fixed

- Search and pagination could remain locked after leaving a pending request and returning. Their stale-response early returns bypassed clearing the busy boolean. Busy reads now hold the initiating request epoch; navigation releases abandoned reads, and `finally` clears only its own request. An older completion cannot release a newer request's lock.
- Search/pagination responses and errors cannot change the list/status after the initiating navigation has been superseded.
- A late successful share acknowledgment could navigate from the room chooser back into a room. The acknowledgment still clears its pending operation and refreshes room data, but source navigation occurs only if the initiating destination is still current.

The two stuck-read regressions and the share-navigation regression failed before fixes. A separate overlapping-search test holds both responses and confirms the older one neither overwrites the newer search nor permits a duplicate pending request.

## Send audit

Desktop/mobile synthetic-provider tests hold a successful dispatch response, leave Inbox, write in a room and release it. Writing/focus remain intact; returning to Inbox shows accepted with delivery unconfirmed; the provider records one dispatch. No send implementation change was needed for these cases. Existing lost-reservation, unknown-outcome, status-recovery and account-replacement tests remain in the broader regression suite.

This is local transport evidence, not proof of live email delivery or every real-provider failure mode. No external messages, deployment or provider configuration changes were made.

## Verification

The targeted set passed 8 browser checks, including 2 existing late-refresh checks. Focused unit checks passed 38 tests. Lint reports zero errors and 79 existing warnings. Broader and full integration counts are recorded in the execution plan after completion. Logs are retained under ignored `test-results/async-continuity/`.

## Integration test maintenance

The catch-up browser suite tried to click a work link after source navigation closed the dialog, and its session-replacement tests assumed Catch up was already open. Tests now open the actual dialog. Frozen history is checked before leaving; a new opening correctly expects a fresh horizon. Both late success/failure replacement-session assertions remain intact. All 6 checks in that file pass.

Notification tests now close the modal before global error dismissal, connection refresh and sign-out, and reopen it to inspect notifications. The recipe check closes Catch up before interacting with the underlying suggestion strip. Those 3 checks pass, preserving cursor, no-extra-write, sign-out clearing and recipe behavior assertions.

Core integration on Node v24.19.0: 4,575 passed, zero failed, one TODO. The prior upload EPIPE failure did not recur; no upload fix is claimed. Focused browser regression set: 115 passed. Broader browser integration is recorded separately, including failures not addressed here.
