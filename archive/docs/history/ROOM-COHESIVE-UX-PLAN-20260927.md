# Project Room: one coherent conversation and attention workflow

Research and implementation plan, 27 September 2026. Baseline: 9b029b69. Evidence labels distinguish source/browser findings, peer reports, and design proposals. This is not a human usability study or a claim that every backlog item is implemented.

## Product direction

Humans should mostly talk, read results, and answer occasional clear questions. Agents need structured work, explicit requests, exact receipts, recovery, and broad tools. Keep those capabilities; expose them when the conversation needs them. Do not copy a project tracker’s entire navigation or turn every chat message into a ticket.

The useful loop is: express intent → see who is doing what → answer a concrete question → receive a result → return later with context intact. Every screen should make the current stage and next action apparent without asking the person to reconstruct an event log.

## Research and what it changes

1. [Linear’s March 2026 interface refresh](https://linear.app/now/behind-the-latest-design-refresh) emphasizes predictable action placement, stronger content hierarchy, subdued navigation and less decorative separation. Application: audit consistency before adding features. Put the relevant action at the source message; use restrained secondary controls. Do not interpret this as evidence Room needs Linear’s complete sidebar or a new theme.
2. [Linear Inbox](https://linear.app/docs/inbox) distinguishes priority attention and supports deferred attention. Application: required decisions must survive a bounded attention card. Reading, snoozing and completing work remain different actions. Room’s existing total count must not be mistaken for complete visibility of required actions.
3. [Linear Asks](https://linear.app/docs/linear-asks-slack) keeps requests connected to the originating conversation. Application: show explicit answer actions in context and retain request status after reload. Clarifying conversation must remain possible without prematurely closing a request.
4. [Linear Triage](https://linear.app/docs/triage) separates incoming requests from accepted work and supports gathering more information. Application: do not automatically promote ordinary chat into work or infer approval from a reply.
5. [Linear notifications](https://linear.app/docs/notifications) describes delayed digests and suppression after a corresponding inbox read. Application: first establish correct read-state and logical item identity, then consider external digest behavior. Do not add another notification channel now.
6. [Linear Search](https://linear.app/docs/search) offers predictable keyboard entry and scoped finding. Room already has search and a keyboard action menu; improve discoverability and result quality before adding another command interface. A source search confirmed existing focus styles and real keyboard navigation tests.
7. [Linear issue relations](https://linear.app/docs/issue-relations) makes relationships explicit. Room should distinguish associated conversations from actual required checks. An open viewer-scoped request is not automatically a dependency of the selected task.
8. [Slack threads](https://slack.com/intl/en-gb/help/articles/115000769927-Use-threads-to-organise-discussions) keeps detailed discussion attached to its source. Application: use contextual request controls and preserve composer state when moving between conversation and detail.
9. [Basecamp 5](https://basecamp.com/5) emphasizes checking notifications and messages without losing the current context. Application: opening Room controls must preserve draft, audience, attachments, selection and return focus. Existing Room browser tests already cover parts of this; retain them.
10. [NN/g progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) supports moving infrequent controls out of the primary task. Application: keep existing Send + Options structure; never hide errors, audience restrictions or required approvals in that disclosure.

These sources inform design choices. They do not establish measured performance advantages or prove that a feature is absent from Room.

## Verified baseline and gaps

- Both production Workers were independently verified at 9b029b69, with active saved membership and the original Durable Object. The earlier split is resolved, not an outstanding defect.
- Live signed-out Room currently exposes Google, email and a collapsed More options entry. Do not repeat the earlier claim that all sign-in methods are visible by default.
- The return brief now separates current work status from historical follow-up on hosted MCP. An older installed connector still bundles old renderer labels; service deployment cannot update that executable.
- An open formal request currently offers generic Reply and Answer controls. Existing lifecycle tests prove the first leaves it open, but the labels do not explain the distinction. This is a demonstrated comprehension gap, not a broken request state machine.
- Catch up has a dialog heading and adjacent disclosure both called Catch up. The disclosure contains attention, reminders, ongoing work and history; calling all of it “Since your last visit” would be inaccurate.
- Owner attention truncates insertion order to 25 items. Informational leases can precede a later required action. Total itemCount already exists; the problem is priority and omitted-action visibility, not wholly undisclosed truncation.
- Mention parsing has a 20,000-character guard despite longer accepted messages. A peer candidate exists, but the delegated validation was blocked by automated review; it is not rerouted or included as verified work in this batch.
- Existing Jev-named admission/receipt scorers are deterministic heuristics, not TypeSafe calls. AI adoption is deferred; do not describe their percentages as model confidence.

## Cohesive layout and behavior specification

### Conversation

Keep one primary composer. Ordinary Send stays ordinary chat. An open request addressed to the viewer has Answer request and a secondary Clarify action. The latter explains that it replies without closing the request. Answer mode names its submit action Send answer. Keep existing controls and handlers; do not add a permanent toolbar row. Requesters and ordinary messages retain ordinary Reply behavior.

After completion, preserve the source message and show current request state. Do not create a second independent task just to track the answer. Retry must retain the original operation identity. Private requests remain participant-only. A stale answer should preserve the draft and ask for the current context rather than silently answering a changed question.

### Catch up

Use one outer title, Catch up. Name its inner grouping Your updates because it includes current attention as well as history. Keep Needs you ahead of optional history. Preserve keyboard focus, Escape, existing disclosures and read-state semantics. Removing bootstrap noise requires a separate event-classification decision; this copy change does not rewrite history or hide events.

### Attention

When the report exceeds its cap, action items precede informational notices, with stable relative order. Under the cap, preserve current ordering. Report omitted actions accurately when actions alone exceed the cap. Provide an existing, authorized route to remaining work; a count alone is not a full queue. If the candidate exposes only an API count, record the missing browser consumption rather than claim a finished human overflow experience.

Do not use Jev to decide whether explicit approval requests remain visible. Policy-required attention is deterministic. Model ranking may eventually help optional context after evaluation.

### Visual details and accessibility

Use existing type, spacing and focus tokens for this batch. Do not invent a second design system. Distinguish primary and secondary actions using existing components, not extra color meanings. Validate desktop and narrow touch layouts, accessible names, keyboard focus return and draft preservation. Prefer text for consequential actions; reserve icon-only controls for familiar navigation with accessible labels. Error text stays adjacent to the relevant input even when advanced controls are collapsed.

## Execution batches and acceptance

### Batch A — selected now

A1. Clarify versus Answer request, including Send answer. Owner: reply_integration, isolated worktree. Existing real-browser lifecycle test must select controls by accessible names at desktop and narrow widths, prove clarification remains open, and prove explicit answer closes only the request. Existing stale/retry/privacy journeys remain green.

A2. Catch up duplicate-label cleanup. Owner: outage_review. One accurate inner label; preserve structure. Existing room-actions and assisted-work browser journeys verify disclosure, focus and no accidental acknowledgment. Inspect rendered narrow screenshot.

A3. Integrate Grok’s frozen owner-attention prioritization candidate and any finished omitted-action follow-up only after exact source/test review. No duplicate implementation while its owner is extending it. Verify 25 information + 1 action, more than 25 actions, stable small-list order, accurate counts and owner-only visibility. Preserve author commits.

A4. Record evidence and ship selected changes only after combined static, browser, Worker and unit checks. Verify both independent Worker revisions and live authenticated behavior. No production test writes are needed for this presentation release.

### Batch B — correctness and security, separate gates

Private referral containment remains highest security priority but has independent-execution limitations. Keep source and evidence review private; do not route around the blocked reproduction or claim the supplied peer tests were independently run. Require an authorized validation/release path and distinguish future prevention from historical membership assessment.

PR1148 guest scopes needs a fresh exact-head review, including older-runtime behavior and user recovery after credential replacement. An old-head verdict cannot approve its changed implementation. Never mix it into a cosmetic release by accident.

Long-message mentions require the retained candidate’s proper validation path. The unrelated short-message inbox report remains separate. Identity/connection lookup candidates need one integration manifest, overlap review and a user-visible failure for each; do not sweep them in because individual tests pass.

### Batch C — lower ceremony and consistent attention

Compare attention decisions with the authoritative nextWorkStep model; investigate stale verification and rejected-decision cases before changing the report. Group duplicate notifications by logical obligation. Evaluate first-visit history noise without discarding unread state. Keep personal dismissal, acknowledgment, answering and work completion distinct.

Update installed connectors through their supported distribution path. Verify a completed result and an open unrelated request through hosted and local clients. Preserve credentials and pending journals. No surprise reconnect solely for presentation changes.

### Batch D — measurable performance and complete journeys

Measure inbox and discussion latency across representative room sizes before caching or infrastructure changes. Separate service time, payload size, network and client overhead. Preserve privacy and freshness in any cache. One peer’s multi-second observation is a hypothesis, not a benchmark.

Board-v2 PR1144 is persistence without completed route mounting according to its description. Decide which concrete journey needs it and whether current work/claims already suffice. A module-only merge is not a shipped feature. Device-auth and status-list prototypes remain frozen until a real consumer and end-to-end case are selected.

Audit sign-in/invitation/recovery as journeys, not isolated screenshots. Audit search, result sharing and stop/reconnect states before adding UI. Retain the user’s simplicity goal: conversation, useful progress, occasional explicit decisions.

## Release and measurement discipline

For each batch record baseline, exact head, test commands/results, known limitations, merged tree and two Worker revisions. A successful shared /api/version is not independent edge deployment evidence. Keep one upload owner. Read-only health checks do not prove every behavioral path; combine actual fixture behavior with deployed revision/configuration evidence.

Measure: finding the latest result without full-history reading; correctly distinguishing clarification from answer; visibility of every required action; draft preservation; duplicate-free retries; median/tail read latency; and unnecessary human interruptions. Do not invent target improvements before collecting a baseline.

## Explicit non-goals

No new sidebar/dashboard, mandatory onboarding, automatic request closure, inferred permission grants, speculative SDK layer, TypeSafe purchase or inference rollout, GitHub replacement, or merge of all available agent branches. Existing auth, request, work and access semantics stay authoritative. Deferral is not completion: the release receipt will distinguish implemented work from this remaining roadmap.

## Implementation checkpoint

The initial delivery integrates request action clarity, the Your updates disclosure label, and Grok’s frozen owner-attention commit `86d90b15874355b6d943e797b0842731966b1b12` (author preserved). Independent local validation passed all 21 request/actions/assisted-work browser tests and all 8 owner-attention tests. Release and full CI are still pending at this checkpoint.

The attention fix protects an action from informational items when the card exceeds 25 entries. It does not make all actions visible when actions themselves exceed 25. Grok explicitly deferred the omitted-action field; the existing total `itemCount` is retained, but the browser badge currently uses displayed items. Accurate overflow presentation and more-than-25-action coverage remain follow-up work.

Static review confirmed the separate mention mismatch: `src/events.js` accepts 65,536 message characters while the mention resolver rejects more than 20,000. The candidate uses the shared constant and adds long-valid/oversized tests; it lacks an exact-limit assertion. Automated review blocked delegated runtime validation, so this candidate is excluded from this delivery.
