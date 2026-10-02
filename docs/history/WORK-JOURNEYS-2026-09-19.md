# Work-journey checkpoint — September 19, 2026

Local branch: `codex/fable-handoff-review-20260919`. No push or deployment.

## What changed

- Mobile background arrivals preserve the visible timeline row when the page, rather than the message list, is scrolling. This fixes a reproduced 9.59375-pixel reading shift. The existing two-pixel tolerance is unchanged.
- The anchor is limited to a visible row, so an offscreen timeline cannot pull the page while other content is being used. Desktop inner scrolling keeps its existing restoration path.
- Credit and voluntary-help browser journeys now return from reply threads to the source work card and open its controls through the visible UI.
- Alternative-contribution and reconnect journeys explicitly reopen or close Catch up when moving between modal and room controls. Behavioral assertions remain intact, including exact retries, attribution, independent verification, preserved writing, service restart, read-marker neutrality and sign-out cleanup.

## Verification

- Initial three-file reproduction: 9 passed, 3 failed after the first navigation repairs. The remaining failures were two hidden Catch up controls and the mobile reading shift.
- After repair: all 12 help/credit/reconnect checks passed, including crowded desktop and mobile rooms.
- Final seven-file run: **18 passed, 2 failed**. All 12 above passed again, plus six composer/header/focus checks. Both release-polish checks failed at text-selection preservation. They passed in an earlier eight-check regression run and have failed historically; they are unresolved, not dismissed as flaky. No selection assertion was changed.
- Full core suite: **4,574 passed, 1 failed, 1 TODO**. Oversized NDJSON import failed with `fetch failed` / `write EPIPE`. Complete-file rerun: **12 passed, 1 failed**, same failure. No upload code changed.
- Lint: zero errors, 79 existing warnings. Diff whitespace check passed.
- No new package/fallback qualification or fresh full-browser run is claimed for this checkpoint.

Logs are retained locally in ignored `test-results/work-journeys/`; browser screenshots and scripted protocol evidence remain under `test-results/`.

## Next actions

1. Diagnose work-card text-selection loss on unrelated updates. Inspect whole-card replacement in `setTimelineWorkNode` and chronological node moves; these are hypotheses, not established causes. Preserve selected DOM where content is unchanged.
2. Diagnose oversized-import response/socket ordering. Retain proof of early 413, bounded body reading and socket cleanup; do not merely accept EPIPE in place of a verified refusal.
3. Repair allowance validation with a visible error and unchanged ledger; inspect the form status target.
4. Resolve the recipe representative/order contract and work-reuse title/byte-size contracts.
5. Run the full configured browser/core gates on the final candidate, then qualify packaging. Only then continue the shell/Activity build and complete human–agent–Inbox workflow.

Ten previous browser failures are resolved; six original ones plus two reproduced selection failures remain. Effective browser accounting across runs is 391/399, not a fully green single run. The core upload failure is a separate gate. Room Catch up remains room-scoped; account-wide Activity is still planned.
