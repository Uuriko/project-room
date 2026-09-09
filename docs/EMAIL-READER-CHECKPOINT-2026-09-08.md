# Private email reader: local checkpoint

September 8, 2026. Implements the reader/private-draft subset of the research-to-build plan. This is fixture-backed local software, not a connected mailbox or release certification.

## What changed

- The existing Inbox requests `view=email-text-v1` for list/detail. Legacy lists stay synthetic-only. Unknown, empty and duplicate view values fail explicitly.
- The server projects account-owned email into bounded plain text, addresses, current connection state and attachment availability. It omits raw headers, mailbox IDs, cursors, HTML and attachment descriptors.
- The reader uses text nodes, one private draft and collapsed Details. Disconnected/reconnect states describe a saved copy. HTML previews and attachment files remain unavailable.
- Saved drafts survive reload and connection disconnection. A metadata-only refresh no longer invents a draft conflict; real source or saved-draft changes retain explicit review. Overlapping refreshes reject stale results.
- Email capabilities explicitly allow drafting but not sharing or sending. Both UI and existing service boundaries refuse those unsupported actions. Synthetic sharing/review/return/send flows retain their existing contracts.

No schema or write-journal change was required: schema 19 and existing source/draft storage are reused. No new runtime dependency, navigation destination or task engine was introduced.

## Authority and scope

Email remains private to its authenticated owning account and browser binding. Room credentials do not become mailbox credentials. The projected Bcc and recipient details are visible only to that account, under Details; none are shared by this change. Connection state is local stored state, not a claim of provider freshness. Fixture labels are intentional.

This iteration does not enable provider OAuth, background network synchronization, arbitrary HTML, attachment downloads, real sending, payments, publication or deployment. No real email account was accessed and no external message was sent. Human journeys were simulated with browser automation, not tested with recruited people. Agent-boundary checks are automated HTTP/domain tests, not new participation by a frontier model.

## Verification

Final runtime checks: 793 core tests passed, including syntax checks, current email/client validation, account isolation, private drafts, replay and cold package reopen. All 20 tests in the current local Workers suite passed, including storage restart, HTTP, migration and historical package scenarios. Historical package tests retain their historical scope and do not certify a current live rollout.

All 236 tests in the complete browser suite passed with zero failures, cancellations or skips. New desktop/mobile journeys inspect inert text, private recipient details, draft persistence, quiet disconnected refresh and unavailable controls. The HTML fixture verifies that tracker markup/scripts are not rendered or fetched. Existing delayed-response tests were updated to intercept the explicitly negotiated URL.

These final runs tested the edited runtime before this documentation checkpoint was committed; only documentation changed afterward. Evidence is retained locally under the ignored `test-results/email-reader-20260908/` directory: the three `project-room-email-reader-*-final-20260908.log` files and five email-reader screenshots. Reproduction uses `node scripts/check.mjs`, the root package's `test:browser` script and the `cloudflare/` package's `test` script with the configured Node 24 runtime. Local loopback permission is required for browser/Workers tests. `git diff --check` also passed.

Earlier attempts are not hidden: the first focused mobile test tried the sidebar refresh while the mobile reader hid it; the test now uses the visible Back → refresh → select path. An initial broad run was interrupted after outdated delayed-response URL interception prevented progress. These were test-harness corrections, not evidence of fixed production bugs. The final rerun uses the corrected harness.

Screenshots inspected: `inbox-email-reader-desktop.png`, `inbox-email-reader-mobile.png`, `inbox-email-disconnected-mobile.png`, and `inbox-email-html-unavailable.png`. The literal image tag visible in the text fixture is deliberate inert-content test data, not a rendered image or normal product copy.

## Next decision

Qualify selected plain-text email excerpts through the existing room work lifecycle and exact reviewed-result return. The browser must show the intended audience and selected text before sharing; private recipient metadata must not leak into room context. Bind the return to the correct account, source revision and result version. Reuse existing commands where their contracts actually fit, and add channel-specific validation where they do not. Sending remains separate from draft adoption.

Do not expand navigation or add another orchestration layer before this journey works end to end. The larger product goal remains incomplete.
