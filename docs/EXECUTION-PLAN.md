# Project Room execution plan

Updated 2026-09-06. This is the ordered implementation plan for the existing [roadmap, issue #6](https://github.com/Uuriko/project-room/issues/6). Coordination and source handoffs belong in [issue #11](https://github.com/Uuriko/project-room/issues/11).

The product goal is a shared place where people and agents can talk casually, find context, and turn a conversation into accountable work when needed. Consumer use should work without a mandatory task ceremony. Enterprise use adds stronger identity, administration, and operational guarantees to the same interaction model.

## Baseline and responsibility

- Published integration baseline: [PR #8](https://github.com/Uuriko/project-room/pull/8), head `1d18471974243b3ffcd77c77124171f1351a4e25`, tree `e6cd77ebbdbe5f315d9ebb0326da68ffb352d069`. This contains a working Node/SQLite service, shared conversation, work records, and return brief.
- Codex owns the isolated correction branch `codex/return-brief-reliability-20260906`, based on that exact head. It addresses return-brief ownership, reopened-work visibility, asynchronous form recovery, and this plan.
- Instinct's identity/A4 work is separate. Its reported head `79126be`, schema 10, and 158 passing tests are author reports, not independently reproduced results. The complete current source is still a dependency for integration. This plan does not authorize changes to that branch or override its publication restrictions.
- [PR #9](https://github.com/Uuriko/project-room/pull/9) remains a separate harness. Grok retains its existing artifact-relay role. Agent availability and an agent-authored instruction do not grant execution authority.
- Merges, deployment, production vendor selection, spending, and human recruitment remain separate owner decisions. A successful local test is not production readiness.

## Ordered work packages

| Order | Package and concrete work | Completion evidence | Current disposition |
| --- | --- | --- | --- |
| 1 | **Reliable return and work state.** Bind catch-up results and failures to session, room, viewer, and one pagination chain. Coalesce More requests, retry failed pages, preserve H versus N, and acknowledge only explicitly. Archive approvals when work reopens; selectors require the current completed receipt and gates. | Deterministic asynchronous tests, full reducer-to-store lifecycle tests, desktop/mobile browser checks. | Implemented in this branch; validation recorded in the PR. |
| 2 | **Session-safe everyday interaction.** Cancel form ownership when access ends. Old work/action responses must not clear new drafts, close a new dialog, show old errors, or release another submission. Provide catch-up loading, failure, and refresh states. | Delayed response + session replacement browser scenarios; retry retains one command ID; private drafts clear on revocation. | Implemented in this branch; validation recorded in the PR. |
| 3 | **Identity correctness before broader access.** Finish trusted recent reauthentication, canonical tenant resolution, invitation bundle validation, opaque pagination, and browser callback corrections. Enforce active account state for existing credentials; make account binding identity-owned; compose assurance change, revocation, and audit atomically. | Reconstructable complete source; independent review; negative and positive tests across login, existing session, room access, link/unlink, suspension, and migration. | Priority blocker. Existing identity source and corrections are required first. |
| 4 | **One usable first journey.** Enter the intended room, understand who is present without false online claims, post a first message, open a thread, find it again, and optionally create self-owned lightweight work. Keep review gates for governed work. | One desktop and mobile scenario with a new participant and agent fixture; observable completion/failure for each step; keyboard focus preserved. | Conversation foundation exists. Integrate reviewed A4 source after package 3; then test the whole journey. |
| 5 | **Recovery and accessibility.** Scoped draft recovery with an explicit device/account/room boundary and expiry; recover from connection loss; useful empty/error states; visible focus, reflow, touch targets, and restrained announcements. | Offline/reconnect and account-switch checks; 320px/zoom/keyboard tests; human VoiceOver, NVDA, and JAWS evidence separately recorded. | In-memory drafts and automated rehearsal exist. Persistent drafts and human assistive-technology validation remain open. |
| 6 | **Trustworthy agent handoff.** Show intended recipient, capability limits, accepted work, execution status, and evidence separately. Add bounded delivery retry, cancellation, and duplicate handling only after the delivery contract is settled. | Two participants and an agent complete one source-linked handoff without forwarding context; redacted receipt records distinguish post/read/accept/execute/verify. | Existing attribution and revision checks are retained. Delivery automation is not part of this patch. |
| 7 | **Enterprise isolation and administration.** Tenant ownership, composite keys, schema coverage, safe connection-pool cleanup, membership lifecycle, session controls, scoped audit access, and data export/retention. | Cross-tenant isolation tests across API, search, background jobs, reconnect, migration, and export; operator recovery evidence. | Design work exists; implementation and independent end-to-end evidence remain pending. |
| 8 | **Operational readiness.** Consistent backups, restore rehearsal, capacity alerts before pilot caps, structured errors, health checks, dependency review, migration rollback, and exact-head release receipts. | Reopen a restored database and verify state/cursors/revocation; measure recovery loss/time; verify release workflow and permission gates. | Pilot caps and tests exist. A production operations claim is not yet supported. |
| 9 | **Product learning and prioritization.** Measure successful first conversations, thread return, finding the next action, and completed human/agent handoffs. Collect failures by journey; simplify screens before adding integrations, voice, marketplaces, or extra dashboards. | A defined denominator, observation window, privacy boundary, and decision threshold for each experiment; no synthetic result reported as human validation. | E1 measurement contract exists. Human research and outreach await their separate authorization. |

These are dependency-ordered packages, not calendar promises. The next implementation after this correction is the smallest reconstructable identity delta. If that source is unavailable, work can continue on the first-journey fixtures and recovery design without fabricating the missing implementation.

## Cross-component invariant scorecard

The audit found defects between slices that each looked sound alone. Every change should name the relevant invariant and attach source/behavioral evidence rather than rely on a test-count headline.

| Invariant | Evidence/status at this handoff |
| --- | --- |
| Inactive account has no authority, including already-issued sessions. | Open: Instinct bucket A-1 reports a gap. Login-only checks are insufficient. |
| Suspended space cannot redeem invitations; inactive member has no authority. | Identity audit reports these hold; current unpublished identity head is not independently verified here. Published member revocation is covered by service tests. |
| Tightening assurance revokes affected credentials in the same transaction. | Open: reported setter relies on caller convention and has no production entry path. |
| Closing an account revokes its linked credentials. | Reported by Instinct; requires integration tests on reconstructable identity source. |
| One active write claim belongs to the accountable member. | Published reducer behavior and existing tests; operator wall-clock trust remains explicit. |
| Work mutations require current revision CAS. | Published store/reducer tests, including concurrent requests. |
| Agent permissions cannot become human administration. | Identity audit reports enforcement on both membership write paths; retain integration coverage. |
| Every new completion faces its own required verification and decision gates. | Existing reducer behavior plus current-completion selector checks in this branch. |
| Account-link authorization reads one identity-owned record. | Open: bucket B-3 reports divergence between projection and identity records. |
| Obsolete requests cannot change another session's view or status. | Return-brief ownership and asynchronous form correction in this branch. |
| Reopened work remains visible through blocked, accepted, and working states. | Approval archival and defensive selectors in this branch. Historical checks remain state-neutral. |
| Reading catch-up never advances a marker; acknowledging H leaves H+1 new. | Store and controller tests; browser workflow coverage. |

## Review and release evidence

For each package, record the base/head/tree, changed paths, source provenance, test command and result, limits, and next handoff. Use the same checked-out source for testing and publication. A current source link, source review, local execution, independent execution, and owner approval are different facts.

Use a failing test of the specific behavior when fixing a defect. Keep the successful control comparable, and change one relevant condition per negative. Tests against synthetic local accounts are engineering evidence; they do not establish human accessibility or product-market fit.

Do not mistake a mutable PR URL for immutable evidence bytes. Pin the exact commit or artifact digest when reporting checks. A database-local hash chain alone does not establish tamper resistance against a privileged database writer. Persist UTC expiry with an explicit clock/restart policy; use monotonic measurements only for suitable process-local elapsed durations.

## Research informing the product choices

The earlier audit used [GOV.UK's user-needs guidance](https://www.gov.uk/service-manual/user-research/start-by-learning-user-needs) to prioritize an observable end-to-end journey; [Slack's unread workflow](https://slack.com/help/articles/226410907-View-all-your-unread-messages) and [Discord's Server Guide](https://support.discord.com/hc/en-us/articles/13497665141655-Server-Guide-FAQ) informed catch-up and lightweight orientation; [W3C's WCAG 2.2 guidance](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/) informed focus, target size, and accessible entry. These are design inputs, not claims that Project Room already meets those products' capabilities or accessibility standards.
