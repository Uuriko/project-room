# Human and agent collaboration: execution plan

20 September 2026. This plan refines PRODUCT-EXECUTION-PLAN.md after the broader interaction and memory research. Persistent mixed rooms remain primary; focused work and private Inbox sharing remain optional. Phase 1 is being implemented; later phases are acceptance-driven scope, not shipped features.

## Product outcome

A person or independently hosted agent can arrive, understand current work, contribute, and resume without another participant manually reconstructing context. Ordinary conversation must remain useful without tasks. The coding request-to-fix journey exercises this foundation rather than defining the entire product.

## Existing foundation and first gap

Overview already shows personal next steps, recorded decisions and results. Catch-up already has return briefs and cursor handling. The authenticated activation pack already supplies participants, open work, pins and a cursor. Reuse these paths. The initial gap is that Overview omits general active work and the activation pack omits the room purpose/instructions and recent recorded decisions.

Create one deterministic orientation selector used by both existing surfaces. Prefer current owner-authored instructions when present; otherwise use the room purpose. Preserve instruction provenance. Show up to three recently updated active items with a total count and stable work IDs; show three recorded decisions with original discussion IDs, author and timestamp. Preserve personalized next steps and completed results in Overview. No generated summary, new database, route or permissions.

## Automation-first interaction refinement

John's refinement: minimize human clicking, configuration and coordination; maximize useful context and continuity for agents. Overview is an optional inspection surface, not a required step. The normal path should work from a room conversation or selected incoming request.

### Default flow

1. A person states an outcome in the room or shares selected Inbox context. Reuse known room/repository defaults; do not ask for information already available. A normal conversation is not automatically an execution request.
2. A connected host receives the addressed request with compact room orientation, relevant source links and current work context. Fetch additional context on demand. Room membership alone does not mean a host is running or has repository access.
3. Within configured authority, agents investigate, implement and check work. Prepare needed work records and context automatically through existing APIs; avoid making humans maintain statuses or handoff documents. Preserve stable identities and idempotency keys.
4. Route an explicit request to the named agent. If unnamed, use an existing configured default where unambiguous; ask one focused question if the choice changes access, cost or intent materially. Do not broadcast execution to every agent.
5. Attach progress and results to the originating conversation. Notify humans for a useful result, a genuine blocker, or a decision requiring their judgment. Batch routine status. Preparation does not automatically grant authority to send, publish, merge or spend.
6. On return, restore the prior location and prepare relevant catch-up automatically. Do not auto-open dialogs, steal focus, scroll away from reading or mark unseen messages read. Existing app login already loads return briefs; preserve that path.

### Who does what

| Automatically, within existing authority | Human involvement when needed |
|---|---|
| Retrieve source context, orient arriving agents, recover resumable state | State desired outcome or correct a misunderstanding |
| Prepare suggested routing, work links and reply drafts | Resolve materially ambiguous intent or recipient/access changes |
| Keep progress current from actual execution events | Supply unavailable information or credentials |
| Deduplicate retries and combine routine notifications | Authorize consequential actions not already covered by standing instructions |
| Surface current results in the original conversation | Accept, redirect or contribute judgment when useful |

Standing authority should remove repeated approvals for the same permitted work. Keep visible pause/redirect controls. Never call a disconnected external host 'working' or show a cancellation as effective before acknowledgement. Do not build a universal autonomy slider; use the existing capabilities and policies.

### Agent value with less ceremony

Use a compact arrival response plus relevant change events, not repeated full-history polling. Preserve source IDs and versions so an agent can act directly without another discovery round. Expose actionable errors and distinguish unavailable context from an empty result. Scoped subscriptions, bounded retries and deduplication should reduce repeated work and token cost. Agent-to-agent assistance remains optional and within the same work/budget boundaries.

### Acceptance checks

A first useful contribution must not require visiting Overview, copying context, creating a task manually or selecting a workflow. Count required human interactions and repeated questions in the pilot, alongside outcome quality and human effort. Include ambiguous plain conversation, an explicit request, a disconnected host, an already-authorized action and a private Inbox source. Verify that automatic convenience does not obscure who receives content or whether execution happened.

These are next integration requirements. The current orientation slice supplies shared context; it does not yet implement automatic host routing or execution.

## Phase 1: arrive informed

1. Derive compact orientation from the authorized room projection.
2. Add it to the activation pack as an additive field and expose the existing endpoint in the agent client.
3. Reuse it in Overview; active work opens existing work surfaces.
4. Document the client entry point and existing resume APIs.
5. Verify current instructions override legacy purpose, cleared instructions fall back, removed/superseded work is excluded, limits and ordering are deterministic, and returned records do not alias mutable state.
6. Exercise real HTTP authentication and desktop/mobile Overview. Keep drafts and focus intact and ensure reading performs no room writes.

Done means both surfaces agree on current orientation and the existing navigation remains functional. It does not mean an external coding host has been qualified.

## Phase 2: resume reliably

Audit return-brief, events, client reconnect and read-marker semantics before adding behavior. Use existing cursors and per-participant state; do not introduce another unread store. Test room changes, interrupted pagination, expired credentials, duplicate events and current decisions that supersede older context. Deliveries, reads and completed actions must remain distinct.

Prototype a compact changes-since-last-visit view only for gaps the audit demonstrates. Preserve reading position and drafts. Show meaningful changes with source links and a recoverable refresh path. Done means a returning human and restarted agent can identify the same changed requirement and continue without duplicating work.

## Phase 3: contribute and steer naturally

Reuse mentions, help requests/offers, work discussion and session controls. Qualify a second human steering and another host reviewing a revision. Distinguish a question from a requested change; acknowledge delivery without pretending the host has acted. Keep routine status compact, source results visible, and agent participation optional. Do not interpret every room message as an instruction or fan out every event to every agent.

Done means a human can inspect a preview, ask a question and request a revision while an agent works; a second agent can review the intended revision; interruption and cancellation status remain truthful. Include a disconnected host and changed revision.

## Phase 4: connect the Inbox to a useful outcome

Choose one real provider using existing Inbox/handoff code. Qualify connect, retrieve, selected excerpt/attachment sharing, shared work, reply draft and intentional send. Keep private messages and subsequent mail private unless explicitly shared. Use a separate room when membership must differ; focused threads do not change access.

Done means a real incoming request reaches a tested result and accurate reply without repeated manual copying or duplicate delivery. Preserve provider account, recipient and original conversation identity. Test retries and missing attachments.

## Phase 5: learn and simplify

Observe three to five small teams over roughly ten to fifteen bounded tasks, comparing with their normal AI-assisted workflow. This is a learning pilot, not a statistically powered experiment. Include technical and nontechnical humans, mobile/keyboard/accessibility use, and at least two independent agent hosts.

Human outcomes: time to understand, steering effort, interruption burden, rework and voluntary return. Agent outcomes: successful arrival, retrieval/tool errors, repeated context transfer, recovery, duplicate actions and useful completion. Shared outcomes: accepted work and useful invitations. Do not optimize message counts, compulsory activity or model-reported preferences.

Remove duplicate projections and adapters revealed by these slices. Prefer fewer concepts and clear contracts over code golfing. Preserve features with focused behavior tests. Defer a swarm scheduler, mandatory roles, reputation graph, universal provider suite, CRDT rewrite and proprietary coding runtime.

## Validation and release

For each slice: inspect current main and shared-agent claims, isolate changes, run focused unit/HTTP/browser checks, then repository checks. Review the diff for privacy, stale state and packaging. Keep runtime changes separate from unrelated fixes. A tested local checkpoint is not production; report merge and deployment status explicitly. Qualify the exact combined commit before release. Track existing mobile focus flake #733 separately rather than weakening assertions.

## Research basis and limits

- Group participation: https://arxiv.org/abs/2501.17258 — small brainstorming studies support testing steerable participation, not universal proactive defaults.
- Concurrent collaboration: https://arxiv.org/abs/2603.02050 — small design-probe studies motivate distinguishing feedback from parallel work.
- Memory: https://arxiv.org/abs/2410.10813 — evaluate updates, time and missing answers as well as recall.
- Tool/context design: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents — engineering guidance for compact, retrievable context.
- Gradual structure: https://www.inkandswitch.com/ink/notes/formality-on-demand/ — conversation can gain structure when useful.
- Competitive baseline: https://docs.dust.tt/docs/user-documentation/pods/overview — shared work and agent initiative already exist elsewhere.

These sources inform hypotheses. They do not establish demand, product uniqueness or Project Room performance.

## Local implementation checkpoint

Phase 1 implemented on `codex/room-orientation-20260920`: shared deterministic orientation in Overview and the existing authenticated activation pack; client accessor; current instruction provenance; bounded active-work and recorded-decision references. No schema or new top-level navigation.

Validation: repository `npm run check` passed (4,656 pass, zero failures, one existing TODO); ten focused orientation/HTTP checks and two desktop/mobile Overview journeys passed. Mobile screenshot inspected. Existing resumption tests passed (37): frozen history windows, member isolation, stale session responses, pagination retries, marker changes and explicit acknowledgement. Login already prepares the return brief; no duplicate resume subsystem is needed.

Remaining: automatic host context assembly/routing, real two-host execution and concurrent human steering are not qualified by this checkpoint. Full browser CI, protected merge and production release remain separate release steps. The change is locally validated, not deployed.


### Automatic request preparation checkpoint

The existing selected request read now automatically bundles current room purpose, versioned instructions and the linked current work record in `preparation`. This reaches both `RoomAgentClient.replyContext()` and the existing MCP `room_read_request` tool without a new workflow or tool. Preparation and current request state are read in the same authenticated storage transaction. The conversation page remains frozen and answer eligibility remains unchanged. The client checks room, instruction revision, work identity and evaluation sequence; older responses remain compatible.

The first integration removes separate instructions/work reads for an addressed request. It does not yet dispatch execution to an external coding host. Scope stays selected: unrelated work/messages, private Inbox data and external resources are not bundled. Next: qualify an actual connected host consuming this prepared request, acknowledging execution and returning revision-bound results.

Validation for automatic preparation: repository check passed (4,658 tests, zero failures, one existing TODO); 24 focused request/client/MCP tests and six request/Overview browser journeys passed. Route documentation check passed. Tests cover selected-only context, no read mutation, missing linked work, old-service compatibility, response identity/revision checks, and fresh instructions during frozen conversation paging. No external provider execution or production deployment was performed.

### Explicit host runner checkpoint

`client/request-runner.mjs` now bridges one configured host callback to a prepared addressed request. It gathers the bounded selected conversation, passes context without the Room credential, journals intent before invocation, saves the exact reply before delivery and uses the existing idempotent reply action. Room/request creation identities scope the run key. It refuses uncertain host reruns, concurrent execution and automatic rebasing after clarification. A durable result can be delivered after restart without invoking the host again.

This is a host integration helper, not a background dispatcher or a preconfigured provider. The callback owns its runtime, timeout, execution authority and costs; it returns plain reply text. No completion/merge/deploy is inferred from that reply. Existing watchers remain read-only. Real HTTP/MCP tests exercise deterministic host callbacks; a live model-host coding session remains to be qualified. Native installation or CLI presence alone is not evidence of integration.
