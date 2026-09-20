# Integration baseline — September 19, 2026

Runtime: Node v24.19.0. Production-code checkpoint: `64691c5` in `codex/fable-handoff-review-20260919`. No push or deployment. This is a development candidate, not a release-ready declaration.

## Results and accounting

- Full core/API suite (`npm test`): **4,575 passed, zero failed, one TODO** (4,576 total). The earlier upload EPIPE did not recur; no upload fix is claimed. The TODO is the existing published-tip/full-run placeholder.
- Focused account/Inbox/draft/connection browser set: **115 passed**.
- Full configured browser suite: **378 passed, 21 failed, 399 total**.
- The full run had already loaded the old Catch up tests and invitation assertion before their repairs. Subsequent complete-file runs passed **6/6 Catch up/general browser checks** and **7/7 invitation checks**, resolving **5 of those 21 failures**. This leaves **16 unresolved checks**. The effective latest result is 383/399, not a claim that one full run was green.
- Notification/recipe test repairs passed **3/3** in a separate run and also passed in the full suite. These are overlapping checks, not additional distinct coverage.
- Eight previously failing tests were repaired in this checkpoint: four Catch up, two notification, one recipe-strip and one invitation check. Existing behavioral/privacy assertions were retained; tests now follow visible navigation or distinguish room and channel labels correctly.
- Earlier selection-preservation failures in release-polish passed in this run without a targeted product fix. Monitor rather than claiming a diagnosed repair.
- Packaged fallback qualification: 2/2 desktop/touch checks passed for candidate `64691c5` against fallback `08e414d`, with no reported issues. This rerun qualifies the committed production changes; the original full-run package checks used the earlier HEAD.
- Lint: zero errors, 79 existing warnings. Diff whitespace check passed.

Root and browser logs are separate. Local evidence is retained under ignored `test-results/async-continuity/`. Source code stayed fixed through the complete suites; targeted test-navigation repairs were run separately where the full runner had already loaded the older file.

## Remaining failure inventory and repair order

| Priority | File | Count | Observed failure | Next action |
| --- | --- | ---: | --- | --- |
| 1 | `scripts/help-contribution-browser-check.mjs` | 4 | Accept action not found after answering a contribution request. | Reproduce the visible thread/channel/work path and verify actor authority; fix navigation or product behavior while preserving the offer → acceptance → review assertions. |
| 1 | `scripts/credit-question-browser-check.mjs` | 2 | Ask about credit button exists but is not visible. | Inspect its containing disclosure and current conversation; follow the actual source-work path before deciding whether the product is broken. |
| 2 | `scripts/reconnect-collaboration-browser-check.mjs` | 4 | Two hidden attention targets; desktop sign-out intercepted/unstable; touch reader shifts about 9.6 px after new discussion. | Separate modal-navigation issues from the genuine reading-position assertion. Reproduce the touch shift independently; do not relax the threshold to make the suite green. |
| 3 | `scripts/spend-allowance-browser-check.mjs` | 1 | Negative input expected native invalidity, but reports valid. | Compare native input constraints with application validation; prove a visible correction and unchanged ledger, and inspect the form error target. No real financial operation is involved. |
| 3 | `scripts/work-recipes-browser-check.mjs` | 1 | Representative/order differs for a repeated definition. | Check event ordering and the documented deduplication rule; preserve definition-only, no-mutation behavior. |
| 3 | `scripts/work-reuse-browser-check.mjs` | 4 | Three multiline-title/CR normalization mismatches; one oversized Unicode request returns 201 instead of expected 413. | Resolve the title-input contract and current request-size boundary. Preserve multiline definition content, explicit retry semantics and byte-size refusal coverage. |

Total: **16**. These are observed symptoms and investigation steps, not a blanket classification as outdated tests. A browser path that fails early has not proved its later privacy/recovery assertions.

## Gate before visual expansion

Repair these bounded core-journey failures, rerun their whole files, then run the configured full suite on the final immutable candidate. Keep account-wide Activity separate from existing room Catch up. After this checkpoint, the next product build remains a coherent shell/Activity contract and one complete human–agent–Inbox workflow, not additional integrations or a backend rewrite.
