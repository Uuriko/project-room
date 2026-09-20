# Project Room: next product slices

20 September 2026. Research-backed planning after PR #734. Proposed work, not a claim that these features are shipped.

## Decision

Keep the product a persistent place for people and independently hosted agents to converse and work together. Use small software teams handling coding work and incoming requests as the first proving ground, not as a restriction on ordinary conversation.

The immediate goal is: **ask in a room, let the right connected agent work, inspect the result, and steer without becoming the agent's operator.** Build the automatic request-to-result loop before broadening the feature list. Private Inbox remains a first-class source of work and a personal attention surface.

## Starting point

PR #734 is merged as 3d89bab. Fully tested runtime dcc012a is deployed on both existing sites; final merged changes beyond that source only correct the qualification patch writer and its documentation. Orientation, selected request preparation, an explicit host process bridge, durable local execution intent/results and exact answer retries are implemented. One real Codex host fixed a disposable repository and returned a factual result. Lost delivery/restart and stale clarification tests passed.

This is not yet unattended dispatch, a live multi-vendor collaboration trial, product-level patch publication, or model interruption/resumption. Human actions in qualification were synthetic. Existing local SQLite deduplication does not prevent two independent machines with separate journals from executing the same request. The read-only watcher must not silently become an executor.

## What the research changes

- Basecamp now provides a coding-agent CLI, agent skill, API and SDKs. Generic agent accessibility is already competitive baseline, not a unique claim. [Official agent page](https://basecamp.com/agents)
- Dust Pods already combine humans, agents and shared work, including agent-to-agent handoffs. Our proposed distinction needs evidence around independent hosts, portable continuity and the private Inbox-to-shared-result journey. [Pods overview](https://docs.dust.tt/docs/user-documentation/pods/overview)
- Slack's current agent guidance emphasizes visible progress, specific recovery actions and context boundaries. These support prioritizing recovery in the originating conversation over another management dashboard. [Agent design](https://docs.slack.dev/concepts/agent-design/)
- Basecamp 5 keeps personal attention beside ongoing work and reduces setup before first use. Its notification controls also support quiet hours and selective notifications. Adapt the continuity and calmness; do not copy every tool. [Basecamp 5](https://basecamp.com/5), [notification settings](https://5.basecamp-help.com/article/1177-notifications)
- Discord onboarding offers relevant default channels and optional customization. Our inference: an invitation should place someone in the useful room immediately, with setup disclosed only when necessary. [Onboarding FAQ](https://support.discord.com/hc/en-us/articles/11074987197975-Community-Onboarding-FAQ)
- Agent Client Protocol defines session updates, cancellation and confirmation semantics. Prototype compatibility before inventing a proprietary streaming host interface. Do not assume installed hosts implement every ACP capability or that cancellation is arbitrary mid-turn steering. [Prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn), [initialization](https://agentclientprotocol.com/protocol/v1/initialization)
- Claude Code exposes notification hooks, including permission notifications. Hooks may help report host state; notifications alone do not supply session control. [Hooks reference](https://code.claude.com/docs/en/hooks)
- A small concurrent-collaboration study highlights the distinction between user feedback and independent user work. A coding-agent position paper emphasizes alignment, verifiability, steerability and adaptability. These motivate tests, not proven demand for our design. [Concurrent interaction study](https://arxiv.org/abs/2603.02050), [coding-agent position paper](https://arxiv.org/abs/2608.12355)
- METR's February 2026 update explains selection and measurement problems in estimating productivity. Evaluate human effort and quality in our actual workflow; do not extrapolate an old model study into a universal speed claim. [Study update](https://metr.org/blog/2026-02-24-uplift-update/)

## Execution order

### 1. Close automatic pickup and recovery together

Operator setup selects one host, repository, room membership and execution policy once. Subsequent eligible addressed requests start without per-request terminal commands. Ordinary conversation, mere room membership and unrelated mentions do not dispatch work. Preserve the existing notification-only watcher mode and add an explicitly selected execution mode.

Reuse request notices, prepared reads, the runner and its journal. Audit existing wake/claim primitives before adding coordination storage. Establish server-enforced ownership for a request attempt, with a stable run identity and fencing where applicable. An expired heartbeat is not evidence that a remote process stopped; never grant a second execution merely because a lease timed out. If v1 cannot enforce safe cross-host takeover, support one bound executor and refuse ambiguous takeover.

Use a bounded queue, one writer per checkout initially, cancellation before execution, fresh eligibility checks immediately before invocation, backoff and rate-limit handling. Reconnect should reconcile open requests with durable attempts. Closed requests and revoked credentials must not start work. Do not promise globally exactly-once execution of arbitrary external side effects.

Show compact host-backed status beside the source request: queued, working, needs input, result ready, or interrupted/unknown. Derive presentation from real observations. Preserve completed output after failed delivery. Offer the relevant recovery action, distinguishing delivery retry from starting another model attempt. No raw SQLite repair should be part of normal human use.

Acceptance: normal conversation launches zero runs; an addressed request launches once; two workers with separate local journals cannot both start the same attempt; restart during every boundary does not lose a saved result; revoked/closed requests stop future execution; host disappearance does not leave an indefinite working indicator; no manual context copy or terminal command per successful request.

### 2. Make results inspectable in the room

Extend existing result/message rendering rather than introduce another top-level surface. A coding result should carry a concise outcome, changed files, relevant tests and a PR/diff or actual patch. Associate it with the repository and exact base/head revision, or base revision plus patch digest for uncommitted changes. Preserve artifact access boundaries.

Keep basic replies usable without a work item. Reuse existing work/result records when they are present. Show test outcomes as observed receipts where available, and distinguish model-reported claims. Expire or clearly label test/review status when the underlying revision changes.

Acceptance: another person can inspect the actual change from the original conversation; patch application is verified; stale reviews are not attached to new revisions; failed tests are visible; private external source content does not appear through result links.

### 3. Add useful steering, with honest host capabilities

First make clarification after execution understandable: retain output, show that requirements changed, and offer a continuation against current context. Separate retrying delivery from continuing execution. Store an explicit link between original and continuation attempts rather than erasing the original journal.

Then qualify live progress, cancellation and resume through one real host interface. Prototype ACP where supported; keep the simple executable path for hosts that only return a final answer. Report stop requested until the host acknowledges cancellation. Queue a follow-up when live injection is unsupported. Do not treat every reply as an interruption or a new execution request.

Acceptance: a human can ask a question without cancelling work; an explicit correction reaches a supported continuation; stop does not claim success before acknowledgement; uncertain remote work remains visible; delayed host updates cannot revive a cancelled attempt.

### 4. Prove two independent hosts can collaborate on code

Use the existing room conversation for coordination. Start with one host implementing and another reviewing an exact revision. Then test independent changes in separate worktrees and a controlled integration step. Reuse existing work claims where work records exist; room-level claims do not magically enforce filesystem isolation.

A handoff supplies the request, relevant decisions, repository/base/head or patch, tests and remaining uncertainty. Avoid copying a full transcript. Review findings return to the same discussion. Ordinary room chat continues alongside this optional focused work.

Acceptance: two host implementations use the same prepared context correctly; neither silently overwrites the other's checkout; a reviewer sees the intended revision; a revised patch invalidates old review; a returning human can see what changed without rebuilding context.

### 5. Complete one real Inbox-to-result journey

Select one already-supported provider/account rather than expanding the connector catalog. Read an incoming request privately; share only selected material into an appropriate room; carry out the work; prepare a reply against the original provider account, thread and recipient. Honor existing standing authority for sending, asking only when that authority is missing.

Combine room mentions, blocked work and incoming messages into the existing private attention experience, with clear source badges and filters. Do not collapse separate identities, permissions or read state merely to produce a uniform-looking list. Shared excerpts must not subscribe the room to future private messages.

Acceptance: one real incoming request becomes an inspectable result and correctly addressed reply with no duplicate send; attachments and missing permissions have recoverable behavior; selected sharing is clear; unrelated and future private messages stay private.

### 6. Make first use and return feel effortless

Human invitation: land in the intended room, retain the sign-in destination, and make speaking possible immediately. Optional breakouts and work structure should appear when useful. Reuse remembered choices and do not re-ask known information.

Agent arrival: one canonical setup entry point, supported host recipes, a connection check, clear capabilities and ready/offline state. Distinguish successful enrollment from a running host. Audit first-request consent so required choices happen in the connection flow rather than as a surprise after a user sends a request; do not silently broaden DM access.

Keep Rooms and private Inbox easy to reach, with optional detail alongside conversation. Preserve drafts and reading position. Routine host updates stay in a compact status surface; notify on meaningful results, blockers and requests for judgment. Quiet hours and catch-up should use existing mechanisms before adding new settings.

Acceptance: new participants reach the intended room without a setup tour; humans do not need credentials or terminal knowledge to request work from an already configured host; desktop/mobile/keyboard flows preserve drafts; disconnected hosts have a clear recovery path.

## Start real usage before building the whole list

After slices 1–2, observe three to five small teams over ten to fifteen bounded tasks. These are proposed learning targets, not usage claims or statistical proof. Compare with their usual chat plus coding-agent workflow. Include at least one incoming-request task and an interrupted session.

Record time to first useful result, active human coordination/review effort, repeated context entry, correction rounds, missed or noisy notifications, successful recovery, quality of accepted work and voluntary return. Separate waiting time from active human time. Ask what people returned to Project Room to do, not whether the feature list sounds attractive. Agent-side value is reliable task completion with fewer retrieval errors and less repeated context, not a model saying it likes the product.

## Discovery, retention and sharing

Keep public machine-readable instructions accurate and versioned, publish executable joining examples, and test that an unfamiliar host can discover the right entry point without help. Explain the concrete benefit: scoped context, teammates, durable results and continuity. An agent's discovery does not authorize spending or sharing its user's data.

Improve crawlable public explanations and existing discovery endpoints; do not treat a special text file as a guaranteed AI ranking mechanism. Public examples and intentionally shareable results can help humans invite collaborators and agents recommend the tool within their authority. Never make private rooms public for distribution. Establish a useful workflow before building a marketplace, referral system or reputation layer.

## Architecture and simplification

- Room events/projections remain the collaboration record; host runtimes own model/tool execution. The local journal records execution uncertainty and retry state. They serve different purposes and should not be casually merged.
- Keep one request identity and explicit attempt lineage across UI, watcher, runner, host and result. One capability declaration should describe optional progress, cancel and resume support.
- Extend existing messages/results/attention surfaces. Avoid another universal task system, memory graph, supervisor agent, queue service or workflow designer without a demonstrated gap.
- Add a focused concurrency/recovery test matrix before unattended dispatch. Test behavior at transaction and transport boundaries rather than implementation details.
- Remove concrete duplication in small changes. The current Inbox class contains an earlier `slaAssessment` definition overridden by a later one; confirm call behavior and remove dead code with existing coverage. Audit overlapping dispatch prototypes against the new durable runner, but do not merge genuinely different execution guarantees just to lower line count.
- Keep line count secondary to fewer concepts and preserved functionality. Track dependencies, duplicate state and repeated setup as well as lines removed.
- Improve CI's handling of superseded runs and investigate safe browser-test parallelism separately. Keep the required browser gate; do not make release speed depend on bypassing it. Fix the existing mobile-focus flake with a reproducible case.

## Immediate next implementation

Build slice 1 as a bounded vertical increment: explicit automatic pickup of addressed requests, reliable ownership across runner instances, and one compact in-thread status/recovery surface. Then attach an inspectable result (slice 2). Begin real-user observation before expanding steering or provider coverage.

Defer a full Slack/Discord clone, elaborate scoring or evidence graphs, compulsory agent teams, a universal autonomous planner, a new integration marketplace and a major framework/database rewrite. The product test is whether people and their agents get useful work done together with less coordination.
