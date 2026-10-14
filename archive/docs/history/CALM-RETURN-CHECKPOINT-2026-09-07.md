# Calm return checkpoint

## Outcome

Catch-up is now one compact, closed-by-default entry before conversation, including
on mobile. It surfaces current responsibilities and private reminders, then lets
people open the exact work record. History and accounting details stay behind a
disclosure. No new navigation, tour, modal-on-join or notification channel.

The long-running product/retention/growth goal remains active and incomplete.
This is a local usability improvement, not proof of retention or referral lift.
The [plan and experiment contract](CALM-RETURN-PLAN-2026-09-07.md) records the
research, assumptions, measurement definitions and next invitation hypothesis.

## Implemented

- One native disclosure above conversation instead of below an unbounded mobile
  Work list. Separate needs, updates and reminder signals; overlapping reasons
  are not added together as a misleading task total.
- First five current responsibilities, then Show all / Show less. Ongoing excludes
  tasks already in Needs you. Task titles are clear, 44px-target links; event
  numbers remain available inside Updates.
- Current work derives from the latest owned room snapshot, using the same
  selectors as the server and agent client. Existing server exports/JSON stay
  compatible. The new browser module is on both exact static-asset allowlists.
- One acknowledgement control, always using the displayed brief's frozen H.
  The note explicitly says all N updates will be marked read even with unopened
  history pages. New H+1 activity remains unread. Removed the old room-level
  latest-sequence control rather than retaining two subtly different actions.
- An ahead-of-snapshot brief reconciles the owned room before exposing links to
  missing records. It cannot replace the frozen history or cross identity changes;
  failed reconciliation exposes no unusable new brief.
- One captured clock drives attention, work cards, available actions and claim
  labels. Visible time-bound reevaluation catches expiry without a new event.
  It makes no network write and stops when hidden or signed out. Same-task focus
  survives a changed next step; card disclosures, recipient and draft selection
  remain intact.
- Two essential labels now scale at 200% text. Existing first-session mobile
  composer visibility, desktop Enter-to-send and touch Return/Send are preserved.

No schema, permission, dependency, provider or analytics changes. This extends the
existing UI and shared authority model, not a separate inbox application.

## Verification

Syntax and 335 core/API checks passed. All 64 browser checks passed, including the
two new desktop/mobile return scenarios. All 7 local Cloudflare checks passed,
including real browser return/restart and the existing v7→v8 recovery tests.
Fifteen exact public assets/imports were checked and prepared. The production
entrypoint bundled locally in memory (194,636 bytes), without invoking deployment.
See the [evidence ledger](evidence/calm-return-2026-09-07.md) for commands and limits.

New checks cover eight owned tasks, one overlapping private reminder, paginated
history, the first-five disclosure, clock-only expiry, updated destination actions,
stable focus, preserved draft/selection/recipient, completion/reopen while history
stays frozen, failed brief refresh with current work still available, sign-out
cleanup, 200% type and reachable controls. Existing multi-session/in-flight
acknowledgement and committed-but-refresh-failed tests remain; the old generic
acknowledgement test was replaced with explicit H+1-preservation coverage.

Three read-only reviewers supplied research and service/UI review. Findings fixed
before checkpoint: missing Node asset entry, ahead-of-snapshot mismatch, separate
clock sampling, stale destination actions, changing focus keys and ambiguous ack
scope. Final service review reported no remaining concrete correctness blocker.
Root remained the sole editor/integrator under the Sites skill.

The first new journey run reached its final sign-out but the synthetic browser
dismissed the existing unsent-draft confirmation; the harness now gives explicit
test consent. The initial Cloudflare restart assertion selected the newly earlier
hidden history copy instead of the conversation; it now targets the visible
message list. Both corrected runs passed. Local self-signed TLS probe diagnostics
continue; no production trust setting was weakened.

Eight new synthetic screenshots are retained in local test-results:
`calm-return-{desktop,mobile}-{closed,expanded,large-text,large-text-controls}.png`.
Screenshots were inspected for layout, readability and reflow. At 200% text the
page intentionally scrolls vertically. These are agent-operated scenarios, not
human participants, device-lab testing, telemetry or measured retention.

## Release state and next work

All changes remain local, unpublished and undeployed. Recorded live remains
application fb90a70, Worker 901be347, Room schema v7. Earlier portable work,
reminders and assignment watching also remain local. Reminders require v8;
a compatible fallback/recovery package still precedes combined release.
No hosted CI or live verification is claimed by this checkpoint.

Next bounded slice: optional previewed invitation note/one small ask. Keep default
Copy link unchanged; reveal note composition only when wanted, show the exact
combined note/link, provide selectable clipboard fallback, keep text in memory
and clear it with the owning identity/link lifecycle. Never auto-include private
room context, send messages, create assignments or add tracking. Plan its state
and failure contract before implementing. Useful contribution, not invite volume,
is the candidate growth outcome.

Later: agent interface ergonomics, lightweight reusable outcomes/templates and
the v8-compatible release/recovery package. Hosted AI, payments, Dasha integration
and actual human retention measurement remain separate staged decisions.
No push, deployment, live migration, DNS/provider change, money, paid compute,
outreach or recurring automation was performed.
