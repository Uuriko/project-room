# Workspace continuity checkpoint

First implementation slice following the Slack/Discord/Basecamp design review. This is a navigation repair, not the new shell or room Overview.

## Reconciliation

Fetched origin before editing: origin/main remains 33685dd7; this candidate was 0 behind / 35 ahead, preserving the complete Fable/Claude handoff and earlier Codex fixes. Working tree was clean. Shared board/channel contained no newer handoff; the legacy bus executable is missing, and the retained inbox ledger had no unread messages addressed to Codex. Claimed this isolated checkout on the board and fallback channel.

Reviewed PR #698 selectively. Its two draft-return test corrections use the visible Back button before operating a room-level work card. Adopted those corrections without removing any content, retry, authority or focus assertions. Did not merge the PR's unrelated changes.

## Product change

Opening a work destination from a message thread previously searched for a card that is only rendered on the room timeline. A shared navigation helper now returns through the normal draft-saving path, selects the work card's proposal channel, closes covering Settings/Catch up dialogs and then resolves the card. Both work-detail links and draft-choice links use this helper.

Ordinary room and thread writing survive the transition. Opening work from the private Inbox retains the unsaved private reply and does not save, send or copy it into the room. Catch up's multiple-draft link now releases modal focus before focusing the timeline choices.

No server schema, authorization policy, provider integration or public asset list changed.

## Validation

- Reproduced the original work-link failure on the pre-change app in desktop and mobile Chromium: the work card never became visible while a thread remained selected. Corrected regression tests pass after the change.
- Final draft-return suite: **17/17 passed**, including thread draft preservation, cross-channel work navigation, modal draft choices, exact retry and session replacement.
- Inbox, narrow-screen focus and work-search journeys: **71/71 passed** in the broader run. This also runs imported discovery/contribution journeys.
- Focused draft-return/channel/return-brief unit tests: **23/23 passed**.
- Lint: **0 errors, 79 existing warnings**. Diff whitespace check passed.

The broader run contained 88 tests and initially reported 86 pass / 2 fail because the two new draft-choice fixtures had no eligible accountable work. Fixed those fixtures to accept owner-accountable work and post drafts at its current revision, waited for replay, and reran the entire 17-test draft-return file successfully. The 71 other checks were already green; no production code changed between those runs. Logs are under ignored `test-results/workspace-continuity/`.

The initial baseline was 76 pass / 1 fail across the three original files; the failure was an old test trying to operate a room card while still inside a thread. Separate new regressions establish the actual product defect, rather than treating that outdated test as proof of it.

This does not declare the full repository green. The previous full-browser checkpoint had 28 failures; the whole suite was not rerun here, and other outstanding failures remain unclassified for this slice.

## Next slice

Implement the Rooms / Inbox / Activity navigation incrementally against the existing account and room surfaces. Activity is currently room-scoped Catch up; making it account-wide requires an explicit aggregation contract, not relabeling the existing dialog as if it already covers every room. Keep that scope honest in the first shell pass. Then add a small room Overview over existing purpose, decisions and results, using these repaired destination paths.

Before expanding providers or visual chrome, retain the now-tested draft, private-content and source-navigation behavior. No push or deployment in this checkpoint.
