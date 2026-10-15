# Simple execution checkpoint

## Implemented

- Preserved the 32-commit Claude handoff at c0bb7792 and continued in an isolated branch.
- Applied the channel-aware reply recovery from PR #698, additionally retaining channel identity when a recovered draft is saved again. Added repeat-recovery and tampered-channel coverage. Original pending command identity/payload remain unchanged.
- Shared an explicit public asset manifest between Node serving and the Worker asset builder. Kept the standalone packager's historical tables and independent asset equality check, with the new module included in exact-commit packages. No new public asset is exposed.
- Applied the root unit CI job proposed in PR #582. Existing browser job remains separate.
- Replaced GNU-only timestamp parsing in scripts/room with already-required jq parsing. Existing Mac claims-board tests now pass.

Code commits: f869e6b and 37abd7a. Branch: codex/fable-handoff-review-20260919. No push, merge or deployment.

## Verification

Local Node v24.19.0, Apple Silicon macOS. Synthetic fixtures only.

| Check | Result |
| --- | --- |
| Focused recovery/assets/board tests | 23 passed |
| Agent setup and reply browser checks | 6 passed, including lost committed answer after reload |
| Cold exact-commit and candidate packaging | 2 passed, including standalone verification outside the checkout |
| Worker runtime suite | 30 passed |
| Final root suite | 4,574 passed; 1 failed; 1 TODO; 4,576 total |
| Repository check with CI mode | Passed; root tests run separately above |
| Lint | Zero errors; 79 existing warnings |
| Full browser suite | 345 passed; 28 failed; 373 total (11m28s) |

The root failure is the oversized NDJSON upload test ending in fetch EPIPE. This was independently reproduced before these changes. The thirteen macOS date failures from the handoff baseline are resolved. No change was made to upload rejection or its socket-close policy.

Test logs are retained under test-results/simple-execution (ignored by Git). The handoff reported 29 browser failures; this run has 28. The lost committed reply is now green. Other remaining failures are not claimed fixed.

## Scope and next step

This completes the bounded implementation cycle, not the full product roadmap. The broad browser suite has known failures; this is not a release-ready claim. Next work should reconcile the remaining PR #698 changes around catch-up, dialog navigation and return, on top of this candidate, before any feature expansion.

The shared manifest removes one maintained copy of the live list. Total code line count has not decreased: the patch adds tests, CI coverage and documentation. The gain is fewer duplicated live definitions and more reliable existing behavior, not compressed syntax.

## Remaining browser failures by script

- scripts/browser-check.mjs: 4
- scripts/credit-question-browser-check.mjs: 2
- scripts/draft-return-browser-check.mjs: 1
- scripts/help-contribution-browser-check.mjs: 4
- scripts/inbox-telegram-check.mjs: 1
- scripts/invitation-check.mjs: 1
- scripts/notification-feed-browser-check.mjs: 2
- scripts/reconnect-collaboration-browser-check.mjs: 4
- scripts/release-polish-check.mjs: 2
- scripts/spend-allowance-browser-check.mjs: 1
- scripts/starter-recipes-browser-check.mjs: 1
- scripts/work-recipes-browser-check.mjs: 1
- scripts/work-reuse-browser-check.mjs: 4
