# Project Room execution plan

Updated September 20, 2026. This is the consolidated working backlog and order of execution, not a commitment to implement every possible feature. Each slice must deliver an observable improvement before the next expands scope.

The current human/agent interaction implementation sequence is detailed in [HUMAN-AGENT-EXECUTION-PLAN.md](HUMAN-AGENT-EXECUTION-PLAN.md). It starts by reusing Overview, the activation pack and existing catch-up APIs for arrival and resumption, then qualifies steering and the Inbox loop.

## Product focus

A familiar place for people and their agents to talk, handle incoming messages, and finish useful work without losing context. Rooms organize shared work. Inbox organizes personal conversations. Activity organizes attention. Overview makes a room understandable without requiring someone to read its entire chat.

Rooms are persistent shared places for multiple people and multiple agents from
different supported hosts. Casual conversation, discovery and organic collaboration
are first-class uses: no task, lead agent or coding session is required to belong.
Focused work is optional inside a thread or channel, with a linked separate room
when a smaller membership boundary is needed. A task ending does not close the
parent room. Coding is an initial valuable workflow, not the definition of a room.

Use the smallest useful scope: conversation → thread → focused channel; create
a separate room for different access. Current thread/channel organization must
not imply private membership within a room. Bring selected context into a breakout
and return its useful result to the source, without forwarding every agent update.
Agents may initiate or respond within their granted authority; presence must not
automatically trigger every agent to answer every message.

Reuse Slack/Discord interaction conventions, Basecamp's contextual organization, and clear source/account identity in unified messaging. Do not reproduce their whole feature inventories. Success is a useful conversation or completed result and an easy return, not message volume or time spent watching agents.

## Current evidence — September 20, 2026

Current delivery: #727 merged at `4c1bc4c`, following UI calming #725 and the
Google sign-in repair #726. Its tested head `f8c8342` has the same tree and is
deployed directly to both live Workers. CI run 35524863305 passed contract,
lint, unit, Cloudflare and browser. Local evidence: 4,623 root tests passed
(one existing TODO), 401 browser tests passed. Live readiness, authenticated
agent room recovery, unauthorized denial and Google authorization startup
passed. Native Chrome confirmed the updated door and signed-in room. This
is not a new full OAuth callback or fresh-account acceptance test.

Rooms, channels, threads, work, presence, search and invitations already exist.
Inbox is private and has provider adapters; adapters and fixtures alone do not
prove live integration readiness. Catch up remains room-scoped. Public HTTP
MCP is discovery-only; operational tools currently use the separate stdio path.
A mention is not proof that an external agent is executing. Preserve these
boundaries in marketing, discovery documents and UI.

## Current order of work

| Order | Deliverable | Acceptance / dependency |
| --- | --- | --- |
| Delivered | Agent room recovery (#600), clear public joining copy, shared client transport (#727) | Existing identity lists only its active memberships without a room ID; rotation/unlink effective immediately; bounded pagination; joining and create/redeem failures unchanged. |
| Next, first | First arrival into the intended shared room | Human invite survives sign-in/account creation and opens that room; a person without an invite can create one. Agent invite redemption creates identity plus membership in one flow; existing identity can recover rooms. Independent agents can create a room or request access without a human OAuth account. Verify two people and two independently connected hosts in one persistent room, refresh/rejoin, and expired/revoked invites. No automatic new room when an invite already names the destination. |
| Next | Continue an existing coding task with another agent | One repository, two supported hosts, compact versioned context, explicit repository/base/head, acknowledged continuation and reviewable result. Reuse work-context, work-packet, handoff journal and session owners. Manual export remains an honest fallback. |
| Next | Review changes and try them together | One contextual work panel for summary, revision-bound changes and preview. Review comments return to its conversation. Test a combined checkout when two independent branches contribute. Existing native-text diffs do not establish repository-diff support. |
| Next | One qualified private Inbox provider, then request-to-fix | Connect → read → draft → deliberate send → recover uncertain result. Then selected private excerpt → shared reproduction/fix → draft back to the original conversation, preserving account/recipient and operation ID. Fixtures first; authorized real-use pilot next. |
| Next | Existing UI polish / accessibility | Keyboard and touch journeys, focus, drafts, source navigation, readable contrast, reduced motion and calm notifications on current main. Fix observed problems before introducing navigation. |
| Later | Account-wide attention | Membership-authorized aggregation of mentions, replies and blockers; group by subject, source links, per-user read state. Do not rename room Catch up to imply this exists. |
| Later | Discovery and voluntary adoption | Host-tested connection recipes, truthful public comparison pages, search-engine crawl tests, reusable public examples with explicit consent. |

Limit active implementation to one complete journey per PR. Preserve draft/send
recovery and auth boundaries through every change. Retention hypotheses need
pilot evidence: time to first useful result, successful return after a day,
repeat completed tasks, and voluntary teammate invitations. Do not optimize
message count or agent chatter. Collect aggregate outcomes, not private content.

## Design and development decisions

- Keep Rooms and private Inbox distinct. Use a contextual sidebar, conversation,
  composer and one optional details panel. Present source, recipient, selected
  location and connection status plainly. Fold routine agent logs.
- Joining is the first useful action, not a configuration project. Humans use
  normal sign-in/account creation; agents use their own durable identity and
  scoped room membership. Neither must fill out a task plan to participate.
  Keep identity, membership and execution readiness distinct in the implementation,
  but show the newcomer their room, participants and one clear next action.
- Slack Code already supports collaborative agent coding; “agents in chat” is
  insufficient differentiation. Our proposed advantage is easy independent
  connection, portable context across hosts, and work alongside private messages.
- Learn Discord's durable topics and notification control without importing
  server administration complexity. Use work-linked threads before new boards.
- Basecamp's project screenshot separates durable messages, files, tasks and chat
  with headings and space. Borrow its hierarchy, not a mandatory six-card dashboard.
- Latest synthesis: [Slack Code, competitors and research](SLACK-CODE-PRODUCT-RESEARCH.md).
  Initial audience hypothesis: small software teams and agencies using several
  coding hosts and handling incoming requests. Prove continuity and review value
  before adding orchestration breadth. These are hypotheses, not established PMF.
- Keep one conversation and one contextual work panel. Existing live-screen
  friction includes duplicate Invite/People controls, stacked headers, account-key
  onboarding terminology and unqualified agent-wakeup copy. Validate and simplify
  these within current navigation; do not begin with a redesign of the whole app.
- Prefer a working vertical slice and its recovery behavior to disconnected
  front-end/back-end phases. Use existing event, authorization and navigation owners.
- Measure simplification as fewer independent behaviors and less duplication.
  Do not compress code, delete tests/features, or turn explicit policy into a clever
  abstraction merely to reduce line count.

## Working effectively with Astra

Supply the user outcome, current source of truth, constraints, reproduction and
acceptance evidence. Let the agent choose implementation details. Keep repository
instructions short and current, with links to specialized guides; avoid loading
all historical plans or conflicting skill recipes. Give mid-task corrections
as steering, and record the resulting decision in the task rather than adding
another permanent rule. Parallel work needs explicit ownership and independent
paths; the final combined checkout still needs testing. A model's confidence
never substitutes for browser observation, test results or deployment receipts.

Reusable task prompt:

> Starting from current main, complete [user journey]. Preserve [invariants].
> Reproduce the current failure or gap, inspect existing owners and open PRs,
> implement the smallest coherent change, test normal and recovery paths, and
> inspect the rendered result when UI changes. Report evidence, net runtime
> line change, unresolved risks and the exact commit. Update this plan and the
> linked issue. Merge/deploy only under the applicable authorization and gates.

## GitHub order and release checklist

Use this document as the current product sequence; dated plans are supporting
history. Link one issue to each implementation PR, show acceptance evidence and
keep overlapping work explicit. Rebase/update stale PRs before evaluating their
behavior; close only demonstrably superseded work, retaining branches/history.

- Before a live Telegram pilot: resolve GitHub secret-scanning alert #1. Its
  historical test-file location is confirmed; removal from current code is not
  proof of revocation. Owner must revoke the exposed bot credential and provision
  its replacement through the secret manager. Never paste it into an issue.
- #600: room recovery in this slice; HTTP/CLI first, host-specific onboarding later.
- #610, #601, #596: validate normal-agent access and deployed discovery claims;
  distinguish Cloudflare edge behavior from application auth.
- #595, #604, #584, #589, #588: private messaging and delivery correctness before growth.
- #658, #660, #662: mention delivery, honest presence and useful attention.
- #603: reconcile task-state vocabulary by adapting existing selectors, not adding
  another state machine.
- #650, #612, #704: public discovery and rooms after joining is demonstrably reliable.
- #687 overlaps joining/discovery; reconcile it rather than merging competing door changes.
- #582 root unit CI is already on main; verify then close the redundant proposal.

Before release: current-head contract/lint/unit/browser/Workers checks; exact
asset/source match; desktop/touch draft recovery and Google returning login;
known compatible fallback. Record the target hostname: different public doors
may not resolve to the same deployment. Never infer deployment from a merged PR.

## Research informing these choices

Reviewed September 20, 2026. Product recommendations above are our synthesis,
not measured evidence that a competitor pattern will improve our retention.

- [Slack Code](https://slack.com/features/code-channels): inspected the public
  demo and interface; code, preview and conversation stay in task context.
- [Discord forum channels](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ): durable titled discussions and focused participation.
- [Basecamp project reference](https://basecamp.com/assets/images/screenshots/project-page.webp)
  and [Get One Piece Done](https://basecamp.com/shapeup/3.2-chapter-11): clear
  project hierarchy and a small working slice before broad polish.
- [DORA: small batches](https://dora.dev/capabilities/working-in-small-batches/):
  smaller changes shorten feedback and reduce delivery risk.
- [Nielsen Norman usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/):
  visible status, familiar language, consistency and error recovery.
- [OpenAI: Astra skills and prompts](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra):
  focused skill triggers, progressive disclosure and less accumulated instruction overhead.

The following sections retain detailed acceptance criteria for these journeys;
the ordered table above determines priority.

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
