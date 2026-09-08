# Resumed browser acceptance — progress, not completion

**Later stopping point:** enlarged-text layout fix, simulated clipboard-refusal evidence, a fresh 160-test pass, restored browser settings and the current restart checklist are in [STOPPING-POINT-2026-09-07.md](STOPPING-POINT-2026-09-07.md). The digest and live tab state below describe the preceding candidate.

The previous goal turn made progress: disposable fixture, status visibility fix and browser evidence. This resumed turn completed further acceptance checks and found/fixed a second UI identity bug. The objective remains unchanged and incomplete.

## Verified this turn

- Submitted the synthetic owner decision in the browser against corrected SHA-256 `66159d954374031ea1e30cdf23e1659552cd8bd92d95a602045a07631c6d7a83`. Work advanced from revision 8 to revision 9; next action reads “Approved; this decision does not execute an external action.” This was not John's real approval.
- Stopped the actual disposable service process, observed the stale-history/reconnecting warning, and reopened the same SQLite file without reprovisioning. Browser refresh restored revision 9, the exact artifact/version, distinct reviewer and approval. The unsent owner draft survived service restart.
- Return brief at event 21 reported nothing needing the owner and no open work involving them. Its changes included the source, proposal, first result, failure, correction, passing review and decision.
- Pending join disabled all dialog controls; Escape did not dismiss it. A timeout retained the form and allowed retry.
- The timeout check exposed a second bug: a visible legacy room-key owner could be replaced with an older authenticated guest account cookie. The old direct join path preferred that account, and switching cleared the owner's reply draft.
- Fixed the UI to revalidate and reuse the identity **already displayed in the same room** before attempting any invitation redemption. This grants no new membership, ignores no authentication failure, and does not reinterpret an old account cookie as the visible user. A changed generation/session during revalidation fails rather than falling through to another identity.
- Browser regression with both cookie types present kept the owner, addressed producer, reply thread, draft and composer focus. A further actual service pause timed out; the current-build retry again retained that identity and draft.
- Replaced raw `signal is aborted without reason` / network errors with an actionable explanation: result could not be confirmed, entries retained, retry the same request. Visibly verified and screenshot inspected.
- Cancelled and full invitations showed their detailed recovery explanation on the final build.
- Five Tab and five Shift+Tab steps stayed within join controls or the native browser/body boundary; no background page control was focused. Escape/close returned to the composer in the observed tests.

## Current evidence

`node scripts/check.mjs`: **160/160 syntax/core/API tests pass**. Three new tests cover visible-room reuse, failed/stale refresh exclusion, and actionable transport error copy. `git diff --check` passes.

Candidate source/test/config inventory: `24ad82a3c2738a57e09f5223d66f728ca6602b23aa993eb06eb544f900140811`. Base HEAD remains `7b5e92fa3245eab684e4a0f2e9c8f16c90441801`, with preserved uncommitted work. This digest, not HEAD alone, identifies the tested source candidate.

New screenshots under `test-results/acceptance-2026-09-07/`:

- `06-approved-before-restart.png`
- `07-approved-after-restart.png`
- `08-pending-join.png`
- `09-owner-reply-preserved.png`
- `10-actionable-timeout.png`

![Actionable timeout](../test-results/acceptance-2026-09-07/10-actionable-timeout.png)

The initial five screenshots and original fixture instructions remain in [the earlier checkpoint](BROWSER-CHECKPOINT-2026-09-07.md). Saved screenshots contain only synthetic test content. No production data, keys or invitation tokens were added to this report.

## Next acceptance work

1. Current-build new-guest entry and same-account guest reuse after the visible-room fix; test a lost/uncertain guest redemption response and same-request retry without creating a second identity. Existing automated client/service tests cover this, but current-browser evidence is still narrower.
2. Clipboard rejection fallback: actual focus/selection plus visible copy instructions. Successful clipboard copying is verified, denied clipboard behavior is not yet browser-verified.
3. 200% text enlargement and final-build narrow layouts for join, management and work next-step controls. The in-app browser rejected the `plus` key name; `super+=` did not change measured dimensions or pixel ratio. Do not count this as a successful zoom test. Use only documented supported browser controls.
4. Source-message → proposed work UI on the current candidate, final error-focus behavior, and a final requirement-by-requirement audit. Keep deeper independent review, real runtimes, external artifacts, physical devices/assistive technology, production operations and dogfooding separate.

## Live resume state

- Original preview `http://127.0.0.1:52330` remains untouched.
- Disposable test origin remains `http://localhost:52331`; reopened server is execution session **45215**, not the earlier now-completed 62030. Its process was resumed after both pause checks; no process is intentionally left suspended.
- Database and credential file remain in `/var/folders/h3/r7zqdttd19v3xzb_q69dqkzc0000gn/T/project-room-acceptance-OiUVFY/`.
- The current test tab (ID 4 in this run) was marked for handoff and is signed in as owner with a synthetic addressed reply draft. Work is approved at revision 9. No viewport override remains.
- Current writes: `src/share-links.js`, `tests/share-link-ui.test.js`, this report and checkpoint pointers. No server authority/schema change, new agents, live integration, publication or spending.

Do not claim full completion from this checkpoint. Remaining checks are actionable work, not a blocked state.
