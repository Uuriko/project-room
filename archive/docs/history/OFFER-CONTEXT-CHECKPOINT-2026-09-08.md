# Selected-work offer reads — local checkpoint

The ambitious product goal remains active. This checkpoint completes a bounded
foundation for compact human controls and agent participation, not the whole
product or a deployment.

## Delivered

- Opt-in authenticated selected-work offer projection, sharing the task's room
  commit, authentication and evaluation clock.
- Selected-task offer records and referenced helpers, without other tasks' plans.
- Availability distinguishes invitation consent, queue capacity, existing offers
  and selected helpers. Selection remains coordination only.
- Strict direct-client negotiation and validation; absent support fails closed
  without another request. Default reads and source opt-in are unchanged.
- Shared HTTP support exercised in the local Workers simulator. No schema change
  beyond the existing schema 14, new endpoint, runner or migration.

Implementation begins from `af1a980` (prior runtime `3984941`) on
`codex/unified-local-20260907`. Checks below exercised the working-tree candidate
on that base, not a live deployment or a claimed release commit.

## Evidence

- Syntax and core suite: **672/672 passed**.
- Existing desktop/mobile invitation browser checks: **9/9 passed**.
- Local Workers HTTP check: **1/1 passed**, extended with offer read/select flow.
- New cases cover cross-task exclusion, capacity, historical participants,
  selection needing review, revoked access, tampered responses, legacy services,
  session fencing and single-request negotiation.

Fresh logs and screenshots are at `/tmp/project-room-offer-reads.PUaL47`:
`core-final.log`, `browser-final.log`, `workers.log`, and
`test-results/human-help-desktop-open.png` / `human-help-touch-open.png`.
Both screenshots were visually inspected. They document preserved existing
invitation flows, not new offer UI. These temporary files should be retained
before removing the local evidence directory.

The first regression run caught a wrong test expectation: revoked credentials
return signed-out (401), not forbidden (403). The test was corrected. The first
browser attempt used an unavailable Chrome path; the successful rerun used the
installed default Playwright headless browser. Logs distinguish failed attempts
from the final passing runs.

Browser actors are simulations; scripted MCP checks are protocol exercises,
not independent autonomous-agent evaluations or evidence of human delight.

## Next slices

1. Expose negotiated offer reads through the existing MCP/CLI interfaces, with
   schema and compatibility checks. Qualify room discovery separately rather
   than interpreting invitation version 1 as queue eligibility.
2. Add thin, revision-bound offer actions and compact contextual human controls.
   Keep selection distinct from task assignment, execution and payment.
3. Test two independent agent clients through offer, selection, changed scope,
   explicit release and review. Document retries and collision behavior.
4. Polish the full invitation-to-reviewed-result journey and reduce competing
   cards and copy, with fresh desktop/mobile screenshot review.

No production publish, remote push, external account operation, payment or
outbound communication occurred. Existing preview processes were not replaced.
