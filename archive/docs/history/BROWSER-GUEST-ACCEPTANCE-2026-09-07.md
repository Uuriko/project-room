# Guest recovery acceptance — latest progress

**Final local result:** [FINAL-LOCAL-ACCEPTANCE-2026-09-07.md](FINAL-LOCAL-ACCEPTANCE-2026-09-07.md) supersedes the pending checks and tab-input limitation below. The browser-created proposal completed through correction, restart and a synthetic UI decision; final focus/layout checks and current requirement audit passed. Broader release gates remain open.

This resumes STOPPING-POINT-2026-09-07.md. The previous goal turn made progress by saving current tests, screenshots and cleanup. This turn implemented further recovery fixes and established new browser/database/client evidence. **The original goal remains active and incomplete.**

## Implemented and tested

- Invitation management now gives operation-specific network recovery: reopen to reload a list, retry the same uncertain creation, or retry cancellation of the same link.
- A confirmed creation is no longer reported as uncertain merely because refreshing the list fails. The created link stays available to copy, with an explicit list-refresh warning. A confirmed cancellation similarly remains confirmed if the follow-up list fails.
- A failed guest join now returns keyboard focus to its re-enabled retry button. This was motivated by browser observation of focus falling to the body when pending controls were disabled. The fix has a handler-level regression test; its final browser recheck remains outstanding.
- Added three tests: operation-specific management guidance; uncertain creation retaining the identical token/request/scope and preserving success after a failed list; and pending join control locking, Escape prevention, retained name/request, failure focus and successful retry.
- Current full `node scripts/check.mjs`: **163 passed, 0 failed, 0 skipped**. `git diff --check` passes.

Current source/test/config fingerprint: `d695ed4b72763d17a37a12bd187186be05f16d1d1cf880fb0e02b269a7098641`.
Base HEAD remains `7b5e92fa3245eab684e4a0f2e9c8f16c90441801`; retained dirty/untracked files are part of this candidate. Nothing was committed, pushed or deployed.

## New browser evidence

All tests used the disposable localhost room, never John's original 127.0.0.1 preview.

1. **Confirmed creation, unavailable refreshed list:** created a real synthetic invitation through the UI, then a one-shot page response-reader hook threw on the successful list response. The screen said “Link created. You can copy it above. The list could not refresh; close and reopen this window to reload it.” The link remained visible and Copy link was focused. The exact previous response-reader descriptor restored itself before throwing.
2. **Existing guest reuse:** after signing out the room-key owner, joining through a new link reused the older Browser Test Guest account membership. The displayed member ID stayed `guest-ccf8046c-b3b6-4de6-9299-4509d394034a`; the room remained at six members. The entered alternate display name did not rename or duplicate that member.
3. **Required name:** submitting a blank name kept the dialog open and focused `join-link-name`, whose native validity reported valueMissing.
4. **Lost successful guest result:** after guest sign-out, a new name, Retry Browser Guest, was submitted. A one-shot Response.json hook awaited the real successful `/api/share-links/join` response, restored the exact original descriptor, then threw a synthetic TypeError before the application received its parsed result. This is a simulated application-level response loss after real server success, not a physical network-loss claim. The dialog retained the name and showed honest unknown-result/same-request retry guidance.
5. **Retry and authority:** clicking Join room again opened one new guest, `guest-5b40fec9-0c6f-44dd-93c5-794d7ef84ad2`. The room showed seven members; invitation management was hidden and Start accountable work disabled. A synthetic message was saved and a heart reaction increased the owner message's count from one to two.
6. **Same-member continuity:** opened a reply to the owner message, addressed it to Test producer, entered a synthetic draft, and reopened the invitation using the same page query (`?room=commons`) plus its join fragment. Joining again retained the guest ID, full draft, recipient `producer`, reply thread and composer focus. Attempting a URL that removed the query first triggered an aborted full navigation; it did not erase the draft and is not counted as successful in-page reopening.

The management and guest browser scenarios preceded the final retry-focus edit. They prove those observed behaviors on that candidate, not a blanket final-build browser pass.

An initial fetch-wrapper fault attempt did not affect the clients' already-bound fetch implementation. It was explicitly triggered and restored without contacting the service; no failure test is claimed for that attempt. The subsequent response-reader tests above did trigger. No fetch, response-reader, clipboard, viewport or enlarged-text override remains intentionally installed.

## Authoritative persistent evidence

Read-only SQLite inspection after the browser scenarios found:

- Room sequence: **24**.
- Exactly **one** member named Retry Browser Guest, kind human, with an empty elevated-permission list.
- Latest invitation ID `0253fe28-72f2-453c-8df8-04f293028b48`: maximum two new guests, **one** recorded join despite the lost-result retry and later same-member entry.
- Original synthetic handoff `test-handoff`: completed at revision **9**.

This checks persistent records, not just rendered member counts. The earlier Browser Test Guest's reuse also consumed no extra use on this latest link.

The documented read-only agent CLI was run against this same fixture using its producer key supplied only in the child-process environment:

- `orient`: exit 0, contract/member/scope/work response, one work item at revision 9 with next action `complete`.
- `brief`: exit 0, ownership-scoped history/current response.
- `changes 0`: exit 0, 24 events with continuation fields.

These commands do not start an AI, mark anything read, or perform external work. The synthetic end-to-end handoff test was inspected and rerun: it checks proposal/source, producer acceptance, exact SHA-256 text, failed review, actual database restart, correction with old verification/decision cleared, duplicate passing review, owner decision and revoked-key rejection. That supports the local scripted contract, not independent organizational review.

## Screenshots

Three additional local files in `test-results/acceptance-2026-09-07/` were saved and visually inspected:

- `18-created-list-refresh-failed.png`
- `19-guest-committed-response-lost.png`
- `20-guest-retry-and-reply-preserved.png`

There are now 19 saved screenshots total; numbering still skips 13. Screenshot 18 displays a portion of a disposable invitation URL. Treat these as local synthetic evidence, not universally token-redacted public assets. Screenshot 19 predates the keyboard-focus correction.

## Browser limitation and exact resume state

After the successful continuity test, sign-out in tab 7 stopped responding during a possible native draft-discard confirmation. Its mouse operation timed out; subsequent tab inspection, a documented [JavaScript-dialog response](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-handleJavaScriptDialog), and close all timed out while the control tried to enable tab focus. Native Codex app control was denied, and that boundary was respected. An asynchronous question asked John to confirm clearing only disposable test drafts if the dialog is visible. The prompt itself was not successfully inspected, so its presence remains a likely cause rather than a proven diagnosis.

A fresh disposable tab 8 rendered the authentication page, but subsequent form actions did not produce a confirmed owner login; key-entry checks returned an empty field. Do not count it as an authenticated working tab or claim sign-out completed. No process restart, cookie deletion, or safety-setting change was attempted to force progress.

Last available browser inventory:

- Tab 1: original `http://127.0.0.1:52330/`, untouched.
- Tab 7: disposable `http://localhost:52331/?room=commons`, guest continuity evidence; sign-out outcome unconfirmed.
- Tab 8: disposable `http://localhost:52331/`, authentication view; owner entry unconfirmed.

The service still answered all three agent CLI reads. Existing temporary database and credential paths remain those in STOPPING-POINT-2026-09-07.md. No process is intentionally paused. Revalidate handles, tabs, cookies and link expiry on resume; do not repeat mutations merely because a UI operation timed out.

## Still required before local-goal completion

1. Clear or otherwise resolve the visible test-tab confirmation through approved browser controls or John's action, and verify input is actually working.
2. Browser-check the final retry-focus change and error retry with keyboard; repeat affected guest checks if implementation changes further.
3. Source-message → proposed work through the current owner UI. The completed browser handoff started with seeded work; automated proposal coverage is not equivalent to this UI check.
4. Finish normal narrow/enlarged-text work next-action and join-submission checks, inspect screenshots and restore temporary test settings afterward.
5. Reconcile all requirement evidence into a current final acceptance audit. Older policy-blocked and 155-test audit text is historical; this temporary input issue is different. Keep independent review, live runtimes, MCP compatibility, physical-device/assistive-technology, operations and dogfooding gates explicitly separate.

No full completion or release approval follows from 163 passing tests. This turn made substantive progress and does not satisfy the repeated-no-progress threshold for marking the goal blocked.
