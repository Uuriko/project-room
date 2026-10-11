# Notion lessons and the Room coordinator

> Integration correction: the simple watcher described below was superseded locally by existing PR2612 (`147c1027`), which also handles owned-attempt recovery and exclusive ownership. See `COORDINATOR-EXECUTION-PLAN-20261011.md` for current implementation status. Earlier test receipts remain historical.

Research and source inspection: 2026-10-11. Recommendations below are Project Room design decisions, not claims about Notion's private implementation. No upstream code has been copied or dependency installed.

## Decision

Keep one Room identity as the default human-facing collaborator. Attach a persistent, qualified execution host; the identity must survive a model or host replacement. Specialists receive scoped jobs and return results to that coordinator. Direct agent conversations remain available. Human conversation stays the primary workspace.

Borrow Notion's shared context, reusable records, and progressive disclosure. Keep the compact chat interaction already chosen for Project Room. Do not turn onboarding into an agent builder or require a Notion account.

## What the research changes

| Notion pattern | Project Room application | Avoid |
| --- | --- | --- |
| Personal Agent versus independently permissioned Custom Agents | Explicitly distinguish a user's private assistance from shared Room execution | Treating everyone's private access as pooled room access |
| Chat, Activity, Settings for agents | One conversation; optional activity details and room settings | Permanent orchestration panels in ordinary chat |
| Specific triggers and manual test runs | Explicit Ask Room or direct address; preview automation before enabling it | Launching multiple agents on every message |
| Agent handoffs with a primary agent assembling the result | Preserve one answer publisher, delegate only useful independent work | Multiple workers announcing acceptance and competing answers |
| Linked views over canonical records | Chat cards, work view and dashboards read the same work/run records | Separate task databases per surface |
| Editable persistent instructions | Short room charter, separate from personal preferences and temporary instructions | Treating arbitrary retrieved chat as operating policy |
| Configuration history and activity | Track the configuration revision used by a run; inspect failures in place | Requiring humans to read machine logs to learn a request failed |

Sources: [Custom Agents](https://www.notion.com/help/custom-agents), [sharing and permissions](https://www.notion.com/help/custom-agents-sharing-and-permissions), [agent instructions](https://www.notion.com/en-gb/help/instructions-for-notion-agent), [best practices](https://www.notion.com/help/best-practices-for-creating-and-optimizing-a-custom-agent), [linked views](https://www.notion.com/help/notion-academy/lesson/linked-views).

Notion's permissions documentation explicitly says shared agents can expose information their callers cannot directly access. Our design should make intentionally shared resources explicit, and preserve requester and destination visibility for other context. A shared conversation must not silently inherit every participant's private connectors.

Notion documents agent credit consumption across the workspace. Project Room should make a run's budget and actual usage inspectable, with a clear cap and understandable failure feedback. This belongs behind details unless a decision is needed, not beside every message. [Notion credits](https://www.notion.com/help/buy-and-track-notion-credits-for-custom-agents).

Their CRDT engineering article describes preserving simultaneous rich-text edits, including block splits. Adopt the principle that concurrent contributions must survive; do not introduce a CRDT into our append-only chat just to imitate Notion. Existing run revisions and pending input acknowledgements are the right starting point. Consider a proven collaborative editor separately if we introduce a genuinely shared editable document. [Engineering article](https://www.notion.com/blog/how-notion-handles-concurrent-editing-with-crdts).

## Lore: use, copy, or adapt?

Recommendation: adapt selected mechanisms into existing Room context; offer a Lore/Notion connector later for teams that already use it. Do not make Lore's Notion persistence a required backend.

Lore is a shared memory system with human-readable records, scoped recall and maintenance. Its engineering report separates retrieval success from whether memory helps complete real work. It reports improvements and some regressions; those vendor-run evaluations are not evidence of equivalent gains in Project Room. We should evaluate clean, stale, conflicting and irrelevant memories against a no-memory baseline. [Engineering report](https://www.notion.com/blog/building-shared-memory-for-ai-agents-in-notion).

Read-only clone: `/tmp/project-room-notion-lore-1011`, source revision `6e741b1bb91a36b47213f4d3af5bbdfaa2f2081d`. Inspected README, LICENSE, domain memory types, scope matching, confidence decay, and synopsis budget policy. This was a targeted review, not a whole-repository audit.

- Reuse the idea of explicit scope and expiry. Room, project, person and run scope must still pass Room authorization; a retrieval filter is not an access-control boundary.
- Distinguish durable decisions/procedures from temporary operational receipts. A pending deploy claim should expire or resolve; it should not become permanent project truth.
- Link sources and superseded records. Keep conflicting evidence visible rather than silently averaging incompatible instructions.
- Retrieve compact summaries first, expand selected source records only when useful. Our existing context projections already provide this shape.
- Evaluate memory by successful tasks and harm rate, not only recall or more frequent memory tool calls.
- Do not copy confidence-on-citation unchanged. Source `src/core/decay.ts` bumps confidence on citation and currently makes ranking confidence factors neutral. Repetition is not independent verification. Track relevance/use separately from evidence quality.
- Do not copy Notion property extraction or its database schema wholesale. These couple the implementation to a different storage and permission model.

MIT source can be reused with its copyright and permission notice retained for copied substantial portions. Preserve upstream revision and license in any future vendored module; copying the design does not require importing its dependency graph. [Source and license](https://github.com/makenotion/lore/tree/6e741b1bb91a36b47213f4d3af5bbdfaa2f2081d).

## Existing Room implementation and the real gap

Inspected current main `83746c5b`:

- `server/room-assistant.mjs`: named configured coordinator; durable shared requests; per-input status; attempt/revision checks; stale/pickup status; guarded draft and atomic publication; coordinator changes pause existing attempts.
- `client/codex-shared-assistant.mjs`: isolated runtime binding, durable local journal, exact publication retries, late human contribution continuation, streamed public drafts and stop handling.
- `scripts/run-codex-room.mjs`: a selected run can execute, but the command previously exited after that run. It did not discover the next queued human request.
- `server/room-context.mjs`: compact versioned catch-up with references rather than whole message bodies.
- `server/work-context.mjs`: existing work context and room charter projection. Extend these before creating another memory service.

New watch mode reuses the runner. It reads the configured coordinator, selects oldest unclaimed queued work for that member and executes serially. It never creates requests from casual chat, takes over an existing attempt, or announces working before a server claim. Existing permission, generation and publication protections remain in the runner. Read or execution failure stops the process for diagnosis; cancellation aborts discovery. Existing attempts require explicit reconciliation by run ID and original journal. This is an initial persistent discovery path, not automatic crash recovery or an always-available hosted service.

Usage after an operator has configured and authenticated the dedicated runtime:

```sh
ROOM_AGENT_CONFIG=/absolute/room.json node scripts/run-codex-room.mjs --watch /absolute/journal.sqlite /absolute/runtime.json
```

No live coordinator settings, credentials, launch agents, provider sessions or background processes were changed by this work. The latest live assistant read timed out; the prior verified muse-room state was unconfigured. Do not describe it as presently connected based on that older observation.

## Next implementation order

1. Qualify one dedicated Room identity and execution host with a real shared request. Only an owner can configure the existing endpoint. Verify membership, host authentication and exact destination, rather than assigning a development agent by display name.
2. Prove two humans can contribute, see real acceptance and one streamed result, then stop it. Include late input, editing, deletion, cancelled publication, competing hosts and restart reconciliation.
3. Join message persistence and invocation reliably. The current two-operation path can still leave a posted message without an invocation if the client closes between them.
4. Add independently verified idle host readiness and prompt event delivery. One-second polling is a bounded compatibility start, not evidence of subsecond production response. There is an open assistant changes-feed PR #2633; review and integrate rather than create a competing feed.
5. Add automatic supervised recovery only after exact journal and attempt reconciliation is tested. A failed process must not cause a fresh duplicate execution.
6. Route delegated results back into the same run and thread; verify evidence before synthesis. Preserve the worker identity internally; show one Room response publicly.
7. Extend existing context with sourced decisions, scoped procedures and expiring operational records. Add a maintenance view and outcome evaluation before unattended memory promotion.

## Acceptance and limits

- A human sees its own message immediately; server receipt and host pickup are distinct.
- Discovery ignores other coordinators, stopped/claimed requests and deleted sources.
- Idle polling does not flood activity; ambiguous execution failure does not rerun work.
- The real HTTP path produces one answer replying to the originating human request.
- Multiple contributions cannot be silently omitted from completion.
- Shared memory cannot widen audience or connector access; expired context cannot silently overrule fresh evidence.
- Local tests are not production latency, authenticated provider execution, or deployment proof.

## Coordinator refinement: one voice, multiple independent conversations

Further research: [Anthropic's multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) stresses scoped delegation, effort proportional to the task, outcome evaluation and resuming after failures. Its reported gains are from its own research workload; they do not justify a swarm for every Room message. [LangSmith double texting](https://docs.langchain.com/langsmith/double-texting) explicitly distinguishes enqueue, reject, interrupt and rollback behavior. We need a deliberate policy for follow-ups rather than accidentally choosing one through a busy flag. This is a hosted LangSmith feature, not a claim that open-source LangGraph supplies that product behavior. [MAST](https://arxiv.org/abs/2503.13657) identifies system design, inter-agent alignment and verification failure categories: a good coordinator prompt alone cannot solve these.

### Product contract

The coordinator is a stable conversation identity plus durable routing and execution state. It is not one enormous model session containing everyone's chats. Route by room, conversation and request; preserve the initiating person and every contribution. Distinct requests may execute concurrently in isolated runtime sessions. Only conflicting work should serialize. Initially the watch command is serial and must be described that way.

Keep fast message admission and feedback independent of long model turns. Server receipts confirm storage; host claims confirm pickup; generated answer deltas provide actual response. Presence alone proves none of those. Do not wait for a long planning call to acknowledge a request, and do not post a synthetic agent sentence to pretend one began.

### Missing pieces, in order

1. **Reliable admission.** Give a human request one stable client operation ID covering message and invocation. Either commit both together or persist an invocation outbox with reconciliation. A closed tab, timeout or retry must not strand a prompt or launch a duplicate. Link run ID, source message ID, requester and conversation before scheduling.
2. **Qualified availability.** Separate membership, configured coordinator, reachable process, authenticated provider, available capacity, and accepted run. Only expose the minimum useful human status. Host heartbeat carries session identity, capabilities, capacity, last successful execution and expiry; session replacement fences prior claims. No silent assignment to whichever agent most recently chatted.
3. **Conversation-aware scheduling.** One active writer per run. Independent conversations can have bounded parallel workers. Fair-share queues prevent one person monopolizing capacity; protect a small interactive lane for questions and corrections. Resource/file conflicts use existing work claims. Avoid creating a separate lock system. Multiple requests in one visible room can still have different logical conversation IDs.
4. **Follow-up semantics.** Reply to an active request normally becomes an attributed contribution to that run. A correction invalidates affected draft content and advances the input revision; the host consumes it at a safe boundary. An unrelated prompt starts a separate run. Stop goes directly to execution control. If meaning is genuinely ambiguous, ask one short clarification. A casual joke or another human's answer should not trigger a swarm. Explicit Ask Room remains predictable while routing is evaluated.
5. **Recovery with external effects.** Persist run, attempt, model session and tool-operation identities. Reconcile before restarting: a lost receipt is not proof an action failed. For providers supporting idempotency use stable operation keys; otherwise inspect the target or mark outcome unknown. Never promise global exactly-once external execution. Test kill points before/after tool action and before/after publication separately.
6. **Bounded useful delegation.** Each child gets objective, relevant context refs, allowed actions, resource scope, deadline/budget and required result evidence. Child updates go to the coordinator; humans get a concise meaningful milestone. Record parent/child provenance, cancellation propagation and dependency outcomes. The coordinator can answer directly when delegation would only add latency. Prefer parallel independent reads; coordinate overlapping mutations explicitly.
7. **A stronger completion contract.** Existing applied-input checks are valuable. Extend completion to require useful output, accounted-for human requests, resolved required child work, and evidence appropriate to the task. A worker saying done is a claim, not a verified outcome. Preserve partial useful results and say clearly what remains unfinished.
8. **Maintained shared memory.** Read the room charter and selected work context; fetch source material on demand. Persist sourced decisions and procedures with scope, revision and lifecycle. Store temporary run state separately. A compact summary points back to original evidence and cannot become an authority grant. Do not auto-promote every transcript summary into memory.
9. **Observable performance and cost.** Trace receipt, admitted, picked up, first useful response, completed and human intervention timestamps. Measure queue delay separately from model latency. Track duplicate side effects, lost contributions, cancellation latency, unjustified delegation, stale-context errors and spend per successful outcome. Inspect details on demand rather than printing telemetry into chat.
10. **Graceful limits.** When no host can execute, preserve the request and show a concise actionable state. A model outage can retry another qualified backend only with attempt fencing and effect reconciliation. Budget exhaustion yields partial results plus a choice; it must not silently drop work or continue uncontrolled.

### Concrete interaction policy

| Human input while Room works | Default behavior |
| --- | --- |
| “Also support Safari” as a reply | Add to the same run, attributed to that person; acknowledge application, not just receipt |
| “Actually use the existing logo” | Correct the relevant requirement; invalidate stale preview and consume at a safe boundary |
| “What have you found?” | Summarize recorded progress without restarting the task or inventing work |
| A new question in another thread | Separate request with its own context and available execution capacity |
| Two people give incompatible requirements | Preserve both; ask the authorized decision-maker to resolve the specific conflict |
| “Stop” on a run | Immediately revoke further publication and request execution stop; distinguish requested from confirmed |
| Worker reports success without evidence | Keep it an unverified result; obtain/check the needed evidence before claiming success |
| Person says thanks to a friend | No agent work unless explicitly addressed or clearly continuing an active agent conversation |

### Counterexamples the acceptance suite should exercise

A ten-minute build cannot block another person's simple status request. Two hosts racing for the same run must produce one accepted attempt. A disconnected host cannot publish after replacement. A deployment that succeeded before a timeout cannot be repeated as a fresh operation. An edited prompt must not be marked applied merely because its ID is unchanged. A private connector result cannot be pasted into a broader room by a shared agent. A recovered coordinator must not forget the last human constraint. A child agent's vague completion cannot cause premature parent completion. A budget-limited research task must stop with useful partial findings instead of spawning more workers.

### Implementation checkpoint

`--watch` and five new tests are implemented locally. Focused watcher plus shared-runtime suite: 28 passed. Affected suite: 75 passed. Lint: zero errors, 127 existing warnings. CLI help checked. A real HTTP test covers human invocation, discovery, claim and one threaded publication, with execution supplied by the test; it is not a real model/provider run. No live activation or deployment.

Before adding parallelism, integrate qualified host state, request admission, and recoverable scheduling with current changes-feed work. The next change should improve those existing boundaries, not introduce a new general-purpose orchestration framework or another queue database.
