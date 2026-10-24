# Reliability gate — September 19, 2026

Candidate: `4a2490b` on `codex/fable-handoff-review-20260919`, following `299ac45`. Node v24.19.0. Local synthetic tests only; no push, deployment, paid action or external message.

## Repairs

- **Reading and copying:** background work-card refreshes now use the same chronological renderer as message updates. The previous two renderers disagreed about equal timestamps and moved unchanged selected text. Removing the duplicate renderer eliminates about 40 lines. The selection regression now forces equal timestamps instead of depending on timing.
- **Work reuse:** the title is a small textarea, preserving multiline definitions and browser-normalized line endings. Both definition fields use the existing 4,096-character domain limit. Required outcome/owner constraints are restored. Oversized Unicode content reaches the byte-limit refusal without being silently truncated and can be corrected without an uncertain retry.
- **Allowance:** native numeric bounds match the application contract; the form has its own error target. Ledger guidance remains separate. A simulated service refusal displays a recoverable error and changes no allowance.
- **Recipes:** equal timestamps break ties by committed event order; the most recent repeated definition represents the group. A structured two-field deduplication key prevents different multiline definitions from colliding. Reuse still copies content only, not authority or results.
- **Uploads:** oversized bodies stop buffering, receive 413 immediately, and drain in-flight bytes before graceful close, with a one-second deadline for stalled senders. Immediate destruction on response finish raced clients still uploading. Node documents that [finish means handoff to the operating system, not client receipt](https://nodejs.org/api/http.html#event-finish). Tests cover declared length without a body, an in-flight known-length upload, real chunked transfer, stalled clients and aborted uploads.
- **Secret scanning:** the full core gate exposed a random false negative for a 34-character Telegram token ending in a hyphen. Explicit alphabet boundaries now recognize those endings and Bot API URL prefixes. Deterministic synthetic tests cover both allowed lengths, punctuation/endings, wrappers and overlong runs. No actual token is used.
- **Catch up test readiness:** the clock-expiry journey waits for the reopened brief to finish before advancing time. Its frozen-history and no-write assertions are unchanged.

## Verification

The first complete core run on `299ac45` exposed the scanner boundary defect (4,575 passed, one failed, one TODO). The contemporaneous browser run exposed the Catch up readiness race; it was stopped rather than treated as final evidence. Both defects received bounded reproductions and repairs.

Final candidate `4a2490b`:

- Full core/API suite: **4,577 passed, zero failed, one existing TODO**, 4,578 total.
- Focused reliability run before the final scanner/readiness follow-up: **44/44 passed**. Additional allowance refusal check: **2/2 passed**. Scanner/readiness follow-up: **17/17 passed**. These overlap full-suite coverage and are not additional distinct totals.
- Full configured browser suite: **399 passed, zero failed**, no skips or TODOs, 418.2 seconds. This is a single complete run on the final candidate, not a combined count from targeted reruns.
- `CI=1 npm run check`: passed syntax, journey coverage, import boundaries, route docs, schema, lint, secret scan (561 files), open-route inventory and wiki checks. Core tests were run separately rather than duplicated.
- Lint: zero errors, 79 existing warnings; `git diff --check` passed.
- Packaging: desktop/touch passed for final candidate `4a2490b` against both nearest ancestor `299ac45` (full suite) and prior reliability checkpoint `82cd33e` (explicit full-hash run), with no reported issues. An initial invocation using short hashes was rejected by the exact-package contract before running; the corrected invocation used full hashes.

Source and tests remain fixed during the final full runs. Checkpoint documentation is updated after results arrive. Logs are retained in ignored `test-results/reliability-gate/`.

## Next product work

Once the configured checks pass, implement [the first Activity slice](ACTIVITY-FIRST-SLICE-2026-09-19.md): current explicit obligations across authorized rooms, a clear source-opening action, preserved writing, and no implicit read/approval/send action. Keep private messages in Inbox and room Catch up scoped to its room.

These tests do not establish live-provider readiness, production deployment, user retention or a human usability study. The existing TODO remains explicit. Main and production still require a deliberate release decision and deployment qualification.
