# Project Room execution plan

Updated September 19, 2026. This is the consolidated working backlog and order of execution, not a commitment to implement every possible feature. Each slice must deliver an observable improvement before the next expands scope.

## Product focus

A familiar place for people and their agents to talk, handle incoming messages, and finish useful work without losing context. Rooms organize shared work. Inbox organizes personal conversations. Activity organizes attention. Overview makes a room understandable without requiring someone to read its entire chat.

Reuse Slack/Discord interaction conventions, Basecamp's contextual organization, and clear source/account identity in unified messaging. Do not reproduce their whole feature inventories. Success is a useful conversation or completed result and an easy return, not message volume or time spent watching agents.

## Current evidence

The isolated candidate contains the 32-commit Fable/Claude handoff plus Codex recovery, packaging and CI fixes. Commit 086047a repairs work destinations from threads and Inbox; 949678d adds room Overview, cross-channel message-source navigation and shorter People guidance. Latest reviewed origin/main: 33685dd7.

Current qualified candidate: `4a2490b`. The complete configured browser suite passes 399/399; the full core suite passes 4,577 with zero failures and one existing TODO. Repository checks and packaged desktop/touch fallback pass. The prior selection, upload, validation, recipe and reuse failures are resolved. See [reliability gate](RELIABILITY-GATE-2026-09-19.md).

Overview is currently a read-only dialog, not the final navigation shell. Catch up is room-scoped, not an account-wide Activity implementation. Adapters and synthetic fixtures do not establish production integration readiness.

## Sequence and dependencies

1. Navigation and draft continuity, alongside classification of failures affecting that journey.
2. Message/send trust and the smallest proven Inbox connection journey.
3. Coherent shell and truthful Activity scope using the stabilized navigation owner.
4. First useful experience and agent/result handoff.
5. Search, attachments, accessibility, mobile and performance refinements.
6. Real-use pilot, measured improvements and release readiness.

Security and session isolation apply to every slice. Code simplification happens while changing real behavior, not as a parallel rewrite. A feature can move earlier when observed use reveals a stronger need.

## 1. Navigation and continuity — immediate

- Distinguish deliberate destination changes from initial restore and background refresh.
- Make browser Back/Forward work between Rooms and Inbox; do not add duplicate history entries for repeated clicks or refresh.
- Preserve current conversation, room/channel/thread, unsent text and reading position as separate state from the destination.
- Keep private source IDs, text and credentials out of URL/history metadata.
- Handle account-only sessions that have not opened a room.
- Give room browsing a distinct destination from returning to the current room; preserve old links.
- Define behavior for reload, copied links, missing/deleted sources and membership changes.
- Prevent a delayed Inbox response from changing the destination after the user leaves it.
- Make source navigation close covering panels and put keyboard focus at the destination.

Acceptance: write a room draft; open/select/write in Inbox; switch back; use browser Back and Forward; recover both drafts and selected source; refresh; follow a source link; no private text reaches room content. Include desktop, narrow screens and account-only sessions. Test lost/delayed responses where they can change navigation.

Implementation: extend the existing Inbox navigation owner. Start with history transitions and dispatch before moving visual chrome. Do not introduce another router or duplicate destination state in a new component.

## 2. Messaging trust — next

- Audit the actual send lifecycle per currently supported transport: local draft, queued, accepted, confirmed delivery where available, failed and unknown.
- Keep account, source and recipients visible before sending. Email retains subject, addressing and reply-all distinctions.
- Preserve draft text and operation identity through disconnects, late replies and retries.
- Reconcile ambiguous sends before allowing a new attempt. A timeout is not evidence that nothing was sent.
- Separate local read/unread state from provider receipts, archive from deletion, and personal triage from shared operations.
- Check connection loss, reauthentication, revocation and capability changes.
- Keep unsupported actions honest and provide open-original fallback where supported.
- Verify attachment preview, filename/type/size, upload failure, cancellation and authorization.

Acceptance: one end-to-end supported source journey, with fixtures for failure/retry and an authorized live pilot before describing it as production-ready. No second delivery on retry; no accidental change of recipient or account. No real outbound send is implied by this plan.

## 3. Shell and Activity

- Keep a small stable global navigation vocabulary: Rooms, Inbox, Activity.
- Use a contextual sidebar, conversation, composer and one optional detail surface. Avoid another permanent column for each feature.
- Reuse existing room/channel lists and Inbox selection rather than rebuilding their models.
- Retain labeled navigation, visible selection, unread emphasis and accessible focus. Keep room settings secondary.
- For Activity, first specify account membership authorization, source room/conversation, paging and per-user read/dismiss semantics.
- Aggregate mentions, replies, explicit review requests and actionable agent blockers. Group repeated changes about the same subject.
- Fetching or viewing a feed must not silently acknowledge its contents.
- Keep badge units explicit; one conversation with many events should not imply many independent obligations.
- Verify removal from a room removes that room's activity and preview content.
- Do not manufacture an account-wide feed by renaming room Catch up. If delivered incrementally, label scope visibly.

Acceptance: one attention item opens the correct source, even from Inbox, with clear audience and preserved drafts; a background event does not steal focus. Read/dismiss actions affect only their documented scope.

Dependency: navigation continuity first; aggregation contract before the global Activity destination is advertised.

## 4. Room orientation, first use and invitations

- Improve the existing Overview only when needed: purpose, useful next action, decisions and results, all source-linked.
- Show a short welcome for a new room with one obvious next action; avoid a dashboard of empty tools.
- Let a person reach their first conversation without configuring agents or every integration.
- Make invitations explain the room, audience, permissions, expiry and what joining means.
- Test returning and new users, expired/revoked invitations, joining the wrong account, and recovery without losing writing.
- Reveal channels, advanced permissions and technical setup progressively.
- Keep public discovery/share opt-in and separate from private room membership.
- Ensure invite/share previews expose only the chosen material. Revocation does not promise to recall exported copies.

Acceptance: a fresh user can enter a room, understand why it exists, find who is present and complete one useful interaction. Observe confusion with actual pilot users before expanding onboarding.

## 5. Agent collaboration and work quality

- Give each agent a clear identity, accountable human where required, scope and permissions.
- Make room orientation concise and source-backed through the existing agent interfaces.
- Distinguish proposed work, accepted responsibility, execution, submitted result, review and approval.
- Make cancellation and pending/unknown actions clear; do not imply a running external action has stopped merely because a room state changed.
- Keep routine tool logs folded away. Publish compact updates when a result, blocker or decision matters.
- Attach discussion and review to the result/work being discussed.
- Preserve provenance and exact versions during adoption, revision and handoff; don't silently substitute a newer artifact.
- Support another human/agent resuming with the current scope and unresolved questions.
- Prevent multiple agents from unintentionally doing the same claimed work. Claims need expiry and explicit boundaries, not just social labels.
- Audit machine-readable errors, idempotency and event/polling behavior so agents can recover without guessing.

Acceptance: one human and one agent complete a small task, a reviewer inspects the exact result, and another participant can understand what happened. No message claiming completion substitutes for a result or required approval.

## 6. Everyday usability

- Search: messages, work, decisions and results with clear scope, useful snippets and correct source jumps; retain permission filtering.
- Reading: stable scroll, unread boundary, new-message indicator, thread return and no focus theft on updates.
- Composer: draft retention, consistent keyboard behavior, attachments and clear errors.
- Mobile: one usable primary surface at a time, keyboard-safe composer, reachable Back, no overlay traps or horizontal overflow.
- Accessibility: keyboard-only journeys, screen-reader names/status, sensible focus return, zoom, contrast, touch targets and reduced motion.
- Empty/loading/error states: state what happened and provide one useful recovery action.
- Visual consistency: spacing, row density, timestamps, selected states, icons and terminology. Remove internal engineering language from ordinary flows.
- Performance: measure initial load, long conversations, large room lists, streaming bursts, search and low-power/mobile behavior before choosing optimizations.
- Notifications: useful defaults, per-room preferences, quiet periods and no noisy agent-event flood.

Acceptance: complete the critical journey at desktop and narrow widths, with keyboard and a slow/interrupted connection. Fix observed problems before decorative redesign.

## 7. Data, security and operations

- Recheck account/room/private-channel boundaries across search, export, notifications, agent context, attachments and Overview.
- Test sign-out, account replacement, key rotation, membership removal and delayed responses for stale private content.
- Keep provider credentials server-side where appropriate, scoped and revocable; do not log message bodies/secrets by default.
- Maintain independent replay/backup/recovery checks. A pretty interface does not compensate for an unrecoverable event history.
- Resolve exact-commit packaging and asset parity regressions before release; preserve one explicit public asset inventory.
- Verify production/main divergence and deployment source before any release. Never infer that landing a commit deploys it.
- Document configuration, migrations, backup/restore, rollback and supported runtime versions.
- Add actionable diagnostics for failed sends, sync lag and revoked connections while minimizing content exposure.
- Review quotas, abuse controls, invitation limits, upload limits and rate-limit recovery using existing mechanisms first.

Acceptance: a reproducible candidate artifact, tested recovery and rollback instructions, and no new authorization leakage. Deployment, real external sends, paid provisioning and spending remain separate actions requiring the applicable authorization.

## 8. Test debt and release gate

- Reproduce each remaining failure on a pinned runtime/candidate; record symptom, owning path, product defect versus outdated test, and a focused reproduction.
- Repair tests that attempt controls hidden behind an actual navigation step; retain their behavioral assertions.
- Add regressions for discovered defects, not snapshots that mirror implementation details.
- Gate critical browser journeys in CI alongside root tests; keep the test-list source of truth shared.
- After a bounded slice, run its meaningful browser/unit checks, lint and relevant packaging checks. Run the complete suites at an integration/release checkpoint rather than after every copy edit.
- Do not mark a release green by silently skipping failing checks or deleting privacy/retry assertions.

Acceptance: every known failure is classified; release-blocking ones are resolved, and accepted limitations are explicit. The current branch is not yet claimed release-ready.

## 9. Pilot, retention and word of mouth

- Use one real project and a small willing group with explicit data/integration consent.
- Observe first useful conversation, first reply, first completed result and whether participants can return comfortably.
- Record where people hesitate, lose context, miss work or leave for another app.
- Establish baseline definitions before setting activation/retention targets. Separate human usage from automated agent traffic.
- Track reliability alongside usage: successful replies, duplicate-send incidents, recovery success and task completion.
- Make invitations and chosen-result sharing easy at moments of actual value. Avoid referral nags, streaks and artificial urgency.
- Compare changes against observed tasks; do not assume competitor patterns cause retention.

Acceptance: a short evidence-backed pilot report and the next small set of improvements. Feedback should narrow scope, not automatically turn every suggestion into a feature.

## 10. Code simplicity throughout

- One destination owner, one maintained public asset list, established selectors for current work/results, and explicit adapter capabilities.
- Share rendering/draft primitives where behavior really matches; preserve email/chat differences and independent security boundaries.
- Delete superseded code only after callers and behavioral checks confirm equivalence.
- Favor small named functions and explicit state transitions over compressed expressions or a generic workflow engine.
- Measure fewer concepts, duplicate definitions, special cases and dependencies. Raw line count is a secondary signal.
- Keep patches reviewable, checkpoint with tests and notes, and coordinate shared files before editing.

## Deliberately later

Additional messaging networks; voice/video hosting; elaborate dashboards; automatic summaries; agent marketplaces; generalized workflow builders; gamification; public community discovery; broad monetization changes; and a backend/framework rewrite. Revisit only when a concrete user need and operational capacity justify them.

## Execution ledger

- Done: handoff/recovery foundation; work-source navigation; read-only room Overview.
- Implemented in this checkpoint: deliberate Rooms/Inbox button history transitions, browser Back/Forward, duplicate-history prevention and account-only destination restoration. Returning to a historical destination for another room opens the chooser without discarding current writing; returning to the current room restores its canonical query. Drafts and private source text are not put in history.
- Follow-up implemented: a distinct room-list destination with Back/Forward and reload restoration; late Inbox list/read results cannot restore hidden reading positions; connection disconnect/reconnect refreshes cannot reopen a departed Inbox. Destination URL writing is shared by both navigation paths.
- Follow-up implemented: abandoned search/pagination can restart; stale completions cannot overwrite or unlock newer searches; a late share acknowledgment preserves a newer destination. Desktop/mobile delayed sample-send checks preserve writing and show one dispatch.
- Still open: remaining copied-link/membership-change combinations, broader real-provider behavior and integration failures. These local-fixture checks do not establish a complete asynchronous-state or live-provider audit.
- Next: implement [the first Activity slice](ACTIVITY-FIRST-SLICE-2026-09-19.md) using current account authorization, attention selectors and navigation ownership.
- Each checkpoint records exactly what changed, final tests, unresolved limitations and whether anything was deployed.

Checkpoint validation: 95 browser checks passed across Inbox, account workspace and draft return; the final focused navigation rerun passed 11 checks (included in those 95, not additional distinct coverage). Focused account/session/deep-link/Inbox/journey unit checks: 38 passed. Lint: zero errors, 79 existing warnings. `git diff --check` passed. No push or deployment. Details: [workspace history checkpoint](WORKSPACE-HISTORY-2026-09-19.md).

Room-list follow-up validation: 109 distinct browser checks pass across the final runs: the broader run passed 108/109, then the Telegram pair passed 2/2 after correcting one obsolete empty-state copy assertion (one overlapping pass). The connection card binding, secret-leak and reconnect checks remain intact. Focused unit checks: 38 passed. Lint: zero errors, 79 existing warnings. This resolves that specific test mismatch, not the historical full-suite backlog. Details: [room-list continuity](ROOM-LIST-CONTINUITY-2026-09-19.md).

Earlier integration checkpoint (superseded by the final reliability gate): full core/API suite passes 4,575 tests with zero failures and one existing TODO. Focused browser set passes 115. Full browser run reports 378/399 passing; five failures were subsequently resolved by complete-file reruns, leaving 16 unresolved checks. Eight older tests were repaired overall in this checkpoint. Do not present this as a fully green release. See [integration baseline and prioritized failure inventory](INTEGRATION-BASELINE-2026-09-19.md).


Work-journey follow-up: the help, credit and reconnect files pass 12/12, resolving ten browser failures. Six original browser checks remain (allowance validation, recipe ordering, work reuse); the final wider regression run also reproduced two historical text-selection failures, so the current browser inventory is eight. A real mobile reading-position defect is fixed without weakening the two-pixel regression assertion. The full core run again hit the historical oversized-import EPIPE (4,574 passed, one failed, one TODO); it remains a release gate. Finish these contract/reliability issues before expanding the shell/Activity build. See [work-journey checkpoint](WORK-JOURNEYS-2026-09-19.md).


Final reliability qualification: all 399 configured browser checks pass in one complete run on `4a2490b`; core 4,577 passed, zero failed, one existing TODO. Static/repository checks and candidate-to-prior-checkpoint browser fallback pass. The known failure backlog above is closed. This establishes the local development gate, not deployment, live-provider readiness or user-study results. Continue with the small Activity implementation contract rather than adding integrations or rewriting the backend.
