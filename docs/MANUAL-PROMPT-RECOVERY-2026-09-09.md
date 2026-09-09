# Manual AI prompt recovery

## Change

The copy/paste contribution route now keeps one clipboard operation pending across closing, reopening and signing out. An issued operating-system copy cannot be cancelled by clearing a dialog. Previously, reopening cleared the local latch and allowed another copy to race it.

The button says **Copying…** while that operation is pending. Settlement releases the current controls, but an old dialog or account cannot report success, show an error or select text in the new view. Moving directly to **Paste AI draft** remains possible; clipboard feedback cannot replace the return form's validation or save feedback. Empty prompt previews cannot be copied.

New prompts also begin at their task heading. Screenshot inspection exposed retained textarea selection/scroll position; resetting while hidden was insufficient, so selection resets with the new text and scrolling resets after the export view is shown. Copy refusal still selects the current prompt for manual copying.

This is a narrow interaction fix, not a new connection or tracking feature. A copied prompt remains secret-free structured context, not permission to perform external actions. A returned draft remains manually attributed/unverified and does not complete, verify or approve work. Source text is opt-in. There is no schema or server transition change.

## Evidence and limits

The expanded real-browser regression failed on both desktop and mobile before the clipboard fix. A subsequent regression caught the hidden-dialog scroll reset on both sizes; the corrected targeted run passed both journeys. Runtime checkpoint: `9de92ca8c392a130fcc64311ce5de7b43383ba42`, following initial fix `66158c3c8984d6eed20d4fa01fa264dedf089b61`.

The tests use isolated synthetic rooms and scripted people. Real browser clipboard success/fallback is exercised; delayed success and rejection are controlled browser stubs. They cover one-flight enforcement including synthetic repeated clicks, close/reopen, sign-out/re-entry, return-form feedback, stale-work acknowledgement, exact lost-response retries, private draft preservation, account reset, desktop Enter/mobile newline, enlarged text, inert returned markup and no external traffic. They do not prove OS-wide clipboard coordination between different tabs/apps or across a full page reload. No native AI product, independent person or provider was exercised this turn.

Screenshots in `test-results/portable-{desktop,mobile}-copy-pending.png` show the corrected prompt at its beginning with Copying… and the return action available. Pending-copy desktop/mobile and mobile stale-return screens were visually inspected. Other existing packet, stale-return and enlarged-text captures are produced by the same tests. These are local ignored artifacts, not published screenshots.

## Next complete journey

Use a fresh manual packet with an original coordinator-authored response, have a simulated contributor paste it, then exercise the exact-result and independent-review/owner boundaries without inventing AI authorship. The current regression establishes mechanics, not that full actual-agent acceptance. The earlier actual connected-helper exercise remains documented separately. Native-host review still requires current model-usage approval; mailbox source rebasing and recovery capacity remain separate pending work. The full goal is active.

No push, deploy, live mailbox, outbound message, money, new inference process or other product changed.

## Final committed-runtime verification

At `9de92ca8c392a130fcc64311ce5de7b43383ba42`, **918 core tests and 37 relevant browser tests passed**, zero failures. Both processes completed. Browser scope: portable work, draft return, native draft, result copy and native result. Workers and the broader Inbox suites were not rerun for this browser-only change. Final logs: `test-results/manual-copy-final-core-20260909.log` and `test-results/manual-copy-final-browser-20260909.log`. Initial failing browser results remain in `test-results/manual-copy-browser-20260909.log`; they are not the final qualification.

Offline package `/private/tmp/project-room-manual-final-tgeqBJ/runtime` verifies the same commit, schema25, 82 files and 24 public assets. Manifest SHA-256: `5a3a6c30c52907adef9f4e1161b28157f489366b654469221e6518f6fd37e215`. Verification record: `test-results/manual-copy-final-package-20260909.json`. Packaging establishes local content consistency, not deployment readiness. Only this documentation is added after the verified runtime checkpoint.
