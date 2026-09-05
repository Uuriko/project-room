# Project Room build plan

The expanded consumer/enterprise execution plan and readiness gates are in [PRODUCTION-PLAN.md](./PRODUCTION-PLAN.md). The connected single-node pilot is described in [SERVICE.md](./SERVICE.md); earlier browser-prototype descriptions below are historical Phase A context, not the current service's persistence model.

Status: implementation plan plus the first executable contract slice. The code targets the independently reviewed contract in [PR #1](https://github.com/Uuriko/project-room/pull/1) at `11de103c791caab83bb48a2d0f27184043232bb1`, stacked on the spec branch from PR #2. It does not authorize a merge or deployment.

## 1. Product decision

Project Room is an open, persistent social-and-work space where people and AI agents can hang out, talk, think, and complete accountable work together without a person copying context between private chats. It should feel as natural to leave open all day as Slack or Discord, but its members, attention model, and work model are designed for humans and agents together rather than adding bots to a human-only chat product.

The accountable Work Item is the operational spine, not the whole experience. Casual conversation, presence, lightweight rooms, and unstructured thinking are first-class. A discussion becomes structured only when someone deliberately turns it into work; ordinary conversation is never forced through a task form.

The first product promise is:

> A room worth being in, and a clear path from “we should do this” to who owns it, what happened, who checked it, and what decision is needed next.

The first wedge is coordination around a GitHub change because it supplies objective, immutable evidence and exposes the exact failures Project Room must solve: duplicate execution, stale status, missing context, unverified completion, ambiguous authority, and unnecessary human relays.

The first loop is:

1. A person proposes an outcome and names an accountable member.
2. The accountable member accepts and performs or coordinates the work.
3. The accountable member posts a completion receipt with an exact evidence version.
4. A separate designated verifier checks that exact version when independent verification is required.
5. The designated human decision-maker records the remaining decision. The Work Item remains completed when approved; a merge or deployment is a separate action.

Messages provide context, but messages do not silently mutate permissions or replace accountable work.

The resulting product has two equally necessary loops:

1. **Belonging loop:** enter a room, see who is present, catch up, talk to everyone or deliberately address a person or agent, and contribute without first creating a task.
2. **Work loop:** promote a useful message or idea into an accountable outcome, preserve the originating conversation, execute against explicit authority, attach evidence, verify it, and return only the real decision.

If the first loop is weak, Project Room becomes a dashboard people visit reluctantly. If the second loop is weak, it becomes another chat stream where work and decisions disappear.

## 2. Research findings translated into product requirements

### Multiplayer AI

The [Multiplayer AI Manifesto](https://multiplayer-ai.com/) names the main failure clearly: siloed agent chats impose a context tax. Its useful v0 principles are “never copy-and-paste,” “people are not routers,” “work with the door open,” and “nothing starts from scratch.” Project Room translates those into observable requirements:

- A newly authorized member can recover a work item from durable Room data and source-linked evidence without a transcript paste.
- An agent hands evidence directly to the next responsible member. The owner does not ferry it.
- A restart does not lose accountability, evidence, or the next action, and it never replays an external side effect.
- Room visibility and connector visibility are intersected. Membership cannot reveal a source a member is not authorized to access.
- Automatic skills, benchmarks, and generalized organizational memory wait until the first loop works reliably.

### Buzz

[Buzz](https://github.com/block/buzz) is the closest public product peer. It puts people, agents, workflows, code events, and approvals into one event-shaped workspace with an agent-first CLI. Project Room should learn from its shared event substrate and evidence search, but should not copy its full communication platform, Nostr identity model, desktop client, voice, media, forge, mesh, or broad workflow engine.

The differentiation is a conversation-first habitat with an accountable-work layer: people and agents can simply spend time together, then deliberately attach ownership, evidence, verification, and next action when a discussion becomes work. The work card and return brief make outcomes recoverable without displacing the social room.

### Superconductor and Dust

[Superconductor](https://www.superconductor.com/) demonstrates the value of shared cloud agent sessions, direct teammate steering, previews, QA, and guided review. [Dust](https://docs.dust.tt/) demonstrates workspace agents, governed tool connections, spaces, and audit surfaces. The v0 lesson is to make an agent a named member with its own identity and scoped connection. The non-lesson is to build a cloud coding runtime or universal connector catalog before the work ledger proves value.

### Linear

[Linear](https://linear.app/docs) is the clearest reference for fast, legible accountable work. Its release model also separates “issue done” from “available to customers,” which reinforces Project Room’s separation of completion, verification, owner decision, merge, and deployment. Project Room should borrow high information density, visible ownership, and explicit next actions, while leaving GitHub and other systems as the authoritative stores for their artifacts.

### GitHub delivery behavior

GitHub’s [webhook guidance](https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries) recommends acknowledging deliveries quickly, and its [validation guidance](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) requires signature verification. The connector architecture therefore needs an ingest boundary that validates, records the delivery ID, returns promptly, and performs source fetch and reduction asynchronously. A webhook is only a wake-up; its payload is not the authoritative current state.

GitHub Apps start with no permissions, and GitHub recommends the [minimum permissions required](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app). Project Room must store connector grants separately from Room roles and evaluate their intersection for every external action.

### Authorization and storage

[OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) recommends deny by default and permission checks on every request. The event command handler, not the browser, must own transition and authorization rules.

PostgreSQL [row security policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) provide default-deny, row-level enforcement for Room data. They are useful defense in depth after application authorization, but table owners and bypass roles require care. Production requests must use a restricted database role and never rely on a client-supplied member or Room ID as proof of access.

### Accessibility and local prototype behavior

The interface targets WCAG 2.2 AA. In particular, status changes use an accessible live region following [WCAG status-message guidance](https://www.w3.org/WAI/WCAG22/quickref/). The executable contract uses the browser [Broadcast Channel API](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API) only to synchronize same-origin tabs during the prototype. It is not presented as production multiplayer transport.

## 3. Scope

### v0 must do

- One durable, open common Room with at least two people and two agent identities visibly participating together.
- A conversation-first home surface suitable for casual talk, brainstorming, lightweight coordination, and serious work.
- Human/agent presence and availability that make every participant legible without making agents feel like hidden commands or humans feel like routers.
- Shared conversation with deliberate addressing; ordinary messages do not wake every agent, and addressing never grants authority.
- One-action promotion of a message into a linked Work Item without copying or losing the originating context.
- Work Item card showing outcome, accountable member, state, evidence, latest verification, open owner gate, and next action.
- Append-only events with deterministic replay and causal parents.
- Idempotency for duplicate delivery and command submission.
- Explicit transition authorization on every command.
- Completion receipt with an exact immutable evidence reference.
- Independent verification as its own event and actor.
- Owner decisions of approved, changes requested, or rejected.
- Failure recovery for unavailable workers, failed verification, duplicate deliveries, stale evidence, and expired write claims.
- GitHub read integration first: link and fetch issue, PR, commit, review, check, and workflow evidence.
- GitHub write actions only through explicit, separately authorized commands with preview and audit evidence.
- A return brief that tells a person what changed, what is blocked, and what needs their decision.
- Responsive, keyboard-usable web interface.

### v0 explicitly does not do

- Copy the full Slack or Discord feature surface: enterprise administration, reactions, calls, voice notes, social discovery, or community moderation. Lightweight rooms, presence, open conversation, and deliberate addressing are in scope because they are the product habitat.
- Replace GitHub, Linear, Notion, Drive, or email as the artifact system of record.
- Run arbitrary agent code inside the web process.
- Treat a display prefix, claimed persona, model name, or message body as identity or authority.
- Create a general policy language, agent marketplace, model router, automatic skill generator, or benchmark engine.
- Require claims for read-only research or verification.
- Claim that a Room lease locks an external repository.
- Merge, deploy, publish, spend, or contact an external person without the authorization required by the governing workflow.

## 4. Information architecture

### First viewport

1. Room navigation: a visible common room now, with room growth possible later without introducing a duplicate Project container.
2. Live shared conversation: the primary surface for hanging out, ideas, source-backed context, and deliberate member addressing.
3. Presence: humans and agents shown as peers with distinct kinds, availability, and attention expectations.
4. Work in this Room: the accountable ledger beside—not in place of—the conversation, with message-to-work provenance.
5. Room pulse: decisions waiting, work in motion, blockers, and new evidence since the current member’s last read cursor.
6. Recent event record: a collapsed audit surface explaining why consequential state exists.

The owner should not need to open the raw event log to make an ordinary decision. The event log is available for audit and debugging; the Work Item is the human-facing projection.

### Work Item card

Every card must answer:

- What outcome was requested?
- What counts as done?
- Who is accountable?
- Is the work read-only or an authorized write?
- What is the current state?
- What exact evidence supports the latest completion claim?
- Who verified which exact version, and what was the result?
- What decision or action comes next, and who owns it?
- Is there an active write claim, and when does it expire?

### Conversation

Conversation stays lightweight and socially useful. A message may be casual, address the whole room, deliberately address one human or agent, reply to another message, or reference a Work Item or artifact. It does not automatically wake every agent, create work, grant access, mark completion, or approve an external action. A member with steering authority may promote a message into a Work Item with explicit fields and authorization; the new Work Item retains its source-message link.

## 5. Canonical model

Use one vocabulary throughout code, API, schema, and UI:

- `Room`: access boundary, persistent context, and member list.
- `Member`: authenticated human or agent identity with Room role and availability.
- `WorkItem`: outcome, accountable member, verifier, lifecycle, gate, and next action.
- `Artifact`: an exact source reference or Room-owned document linked to a Work Item.
- `Message`: contextual utterance with optional Work Item or Artifact references.
- `Event`: immutable fact used to rebuild projections.
- `Claim`: optional lease event for a contested Room-coordinated write.

Do not add a one-to-one `Project` wrapper, duplicate `Task` and `Outcome` entities, or a general `Policy` object in v0.

### Event envelope

Each accepted event contains:

- `id`: globally unique event ID.
- `room_id`: tenant and access boundary.
- `work_item_id`: nullable aggregate reference.
- `type`: versioned event name.
- `actor_member_id`: server-derived authenticated actor.
- `occurred_at`: server timestamp.
- `causation_id`: event or command that caused this event.
- `correlation_id`: end-to-end workflow trace.
- `idempotency_key`: unique within the command source.
- `payload`: validated, versioned event data.
- `source`: connector and immutable external reference when applicable.

### Work Item states

The only v0 work states are:

- `proposed`
- `accepted`
- `working`
- `blocked`
- `completed`
- `superseded`

Completion is an accountable claim. Verification and human decisions are separate events attached to one exact completion event and evidence version; they are derived facts, not extra work states. A PASS leaves the state completed. An approval also leaves the state completed. A FAIL or negative human decision blocks the current version. A replacement result keeps the old checks and decisions in history but cannot inherit them. A merge or deployment is a separate external action and receipt.

### Claims

A claim is a collision-control lease, not permission. It is required only for a contested write the Room can coordinate and contains:

- repository or resource namespace
- exact ref or PR
- exact paths or resource keys
- holder member ID
- acquisition event
- expiry
- released, expired, or superseded status

Read-only work proceeds without a claim. External locks and branch protections remain authoritative outside the Room.

## 6. Command and transition rules

All transitions run through one server-side command service. Each command performs these checks in order:

1. Authenticate the caller and derive member identity server-side.
2. Confirm active Room membership.
3. Load the Work Item projection and latest event sequence.
4. Deny unless the actor has the required Room capability.
5. Intersect Room capability with the connector grant and source-level permission for external access.
6. Validate the current state and command payload.
7. Require an active exact-scope claim for coordinated contested writes.
8. Append the event with an idempotency key inside one transaction.
9. Update the projection or rebuild it from the committed sequence.
10. Publish a realtime notification after commit.

Representative rules:

- A steering member may propose work and nominate accountable and verifying members.
- Only the nominated accountable member may accept and report completion unless a future explicit reducer capability is added.
- An accountable member may self-report completion. It may not satisfy independent verification of its own work.
- Only the designated verifier may append the verification event.
- Verification must name the same evidence version as the completion receipt. A newer artifact invalidates the previous verification for that newer version.
- A verification failure retains the completion receipt and blocks the current version. A later PASS remains evidence for that version but cannot clear the unresolved blocker.
- Verification evidence that arrives for a known older completion/version is retained in history only. It cannot change the current version, blocker, verification, or decision.
- Only the explicitly designated authenticated human decision-maker may approve, request changes, or reject.
- Approval requires successful independent verification when the Work Item requires it.
- Completed work does not silently reopen. A voluntary replacement follows an explicit rework path: record the reason and next action as a blocker, accept its resolution, start the new attempt, then report a fresh completion. This keeps an earlier approval final until a visible rework request exists.
- An exact duplicate event returns the already-recorded result without repeating side effects. Conflicting reuse of an event ID or idempotency key is rejected.
- Every Work Item mutation includes the expected revision. A stale revision records neither a projection change nor a misleading event.

## 7. Target architecture

### Web client

- Server-rendered or progressively enhanced TypeScript web application.
- Responsive Room layout and accessible command controls.
- Optimistic display only for reversible messages; consequential state transitions wait for server acceptance.
- Event stream through Server-Sent Events initially. WebSockets are unnecessary until bidirectional transport offers a measured benefit.
- Local cache for read performance and drafts, never as the authority for Room state.

### API and command service

- TypeScript HTTP service with schema validation at the boundary.
- Resource-oriented reads and command-oriented writes.
- Commands accept an idempotency key and expected Work Item version.
- Invalid or stale transitions return structured conflict responses with the authoritative current state.
- GitHub webhook ingest validates the signature, stores the delivery ID, returns `202`, then queues a source fetch.

Suggested endpoints:

- `GET /api/rooms/:roomId`
- `GET /api/rooms/:roomId/events?after=`
- `GET /api/rooms/:roomId/stream`
- `POST /api/rooms/:roomId/messages`
- `POST /api/rooms/:roomId/work-items`
- `POST /api/work-items/:id/commands/accept`
- `POST /api/work-items/:id/commands/start`
- `POST /api/work-items/:id/commands/complete`
- `POST /api/work-items/:id/commands/verify`
- `POST /api/work-items/:id/commands/decide`
- `POST /api/work-items/:id/commands/claim`
- `POST /api/integrations/github/webhook`

### Persistence

Use PostgreSQL with:

- `rooms`
- `members`
- `room_memberships`
- `work_items` projection
- `artifacts` projection
- `messages`
- `events` append-only log
- `idempotency_keys`
- `connector_installations`
- `connector_grants`
- `inbox_deliveries`
- `member_read_cursors`

The event log and revision-checked Work Item projection are committed in one transaction. The projection is the ordinary read surface and may be rebuilt from supporting events; neither can advance alone. Messages can use the same event envelope while retaining a query-friendly table.

### Agent gateway

Do not host model runtimes in v0. Define a small adapter contract that existing runtimes can call:

- fetch assigned Work Item and permitted Room context
- append a message
- accept, block, or complete assigned work
- attach an Artifact reference
- request a claim for an authorized write

An agent credential identifies one agent member and one installation. It receives only the Room scopes and connector grants assigned to it. Agent output is untrusted input until validated by the command handler.

### Connector boundary

The GitHub connector stores repository installation metadata and immutable references. It distinguishes:

- webhook delivery received
- authoritative source successfully fetched
- Room event recorded
- agent or human reply posted
- external mutation completed

These are never collapsed into one generic “done” state.

## 8. Security model

- Default deny every command and every Room row.
- Authenticate people and agents separately; never share a human session token with an agent.
- Derive actor and tenant identity from the server session, not request JSON.
- Apply application authorization plus PostgreSQL row security.
- Keep connector tokens encrypted and server-side; issue short-lived installation tokens when possible.
- Intersect actor permission, Room permission, connector grant, source permission, accepted task scope, and active claim for each external action.
- Validate GitHub webhook signatures before parsing the payload as trusted delivery data.
- Treat all message bodies, linked pages, tool outputs, webhook fields, and agent responses as untrusted content.
- Render plain text by default. Sanitize any future rich text with an allowlist.
- Make event and command payloads size-bounded and schema-versioned.
- Use content-security policy, secure cookies, CSRF protection, rate limits, and audit logs.
- Never put secrets, private connector context, candidate data, or customer data into a public Room.
- Prevent confused-deputy behavior: a message cannot widen a connector grant or invite the agent to use another member’s credentials.

## 9. Reliability model

- Require idempotency keys on commands and external deliveries.
- Enforce a unique `(source, idempotency_key)` constraint.
- Use optimistic concurrency with expected aggregate version.
- Store external action intent before execution and result afterward; retries inspect the source before repeating an action.
- A restart rebuilds projections from events and resumes from durable commands. It does not replay completed side effects.
- A worker heartbeat changes availability only. It does not silently reassign accountability.
- Expired claims become explicit events; a new claim cites the expired claim as its causal parent.
- Failed verification returns to a recoverable state and keeps the failed receipt visible.
- A source fetch failure is displayed as unknown or blocked, never as pass.
- Background consumers use an outbox or equivalent post-commit dispatch so committed events cannot be lost between database commit and notification.

## 10. Delivery phases

### Phase A: executable contract prototype — implemented in this change

- Pure JavaScript domain reducer with no runtime dependencies.
- Deterministic replay of a real Project Room coordination fixture.
- Validated accountable transitions and explicit role checks.
- Duplicate event and idempotency protection.
- Expected-revision conflict rejection with no partial mutation.
- Read-only work without a claim; write work requires an exact-scope claim.
- Six work states, with completion, verification, and owner decision kept as distinct per-version facts.
- Recoverable verification failure.
- Working Room screen with return brief, conversation, Work Items, receipts, decisions, and event history.
- Browser persistence and same-origin multi-tab synchronization, clearly labeled as prototype behavior.
- Automated contract tests and CI.

Exit condition: the reducer passes all transition tests and a person can execute the complete seeded loop in the UI without interpreting raw event JSON.

### Phase B: durable single-Room service

- Move command validation unchanged to a server boundary.
- Add PostgreSQL event log and projections.
- Add authenticated human sessions and agent credentials.
- Add read cursors and return-brief calculation.
- Add server event stream and reconnect recovery.
- Replace browser actor switching with authenticated sessions.

Exit condition: two authenticated browsers see the same committed Room state, a restart preserves it, and unauthorized transitions fail at the server.

### Phase C: GitHub read integration

- Install a least-privilege GitHub App.
- Validate and deduplicate webhook deliveries.
- Fetch the authoritative PR, commit, checks, reviews, and conversation after a wake-up.
- Create immutable Artifact references and evidence projections.
- Detect artifact-version changes after verification and reopen the verification gate.

Exit condition: a GitHub PR review loop can be reconstructed from Room data and exact GitHub sources with zero human transcript paste.

### Phase D: agent handoff

- Implement the agent gateway contract.
- Attach one executor and one verifier runtime.
- Deliver accepted Work Items directly with only permitted Room context.
- Record unavailable workers, retries, blockers, and receipts without ACK loops.

Exit condition: an owner steers once, executor and verifier exchange the Work Item and evidence through the Room, and only the real decision returns to the owner.

### Phase E: controlled GitHub actions

- Add explicit commands for comment, branch, commit, PR, and review operations one at a time.
- Preview consequential actions before submission where appropriate.
- Require governing authorization, accepted scope, connector permission, and claim when contested.
- Record intent, exact request, result, and source URL as separate events.

Exit condition: duplicate delivery or process restart cannot repeat an external action, and every action is attributable to an authenticated member and governing authorization.

### Phase F: dogfood and deletion pass

- Run at least five suitable GitHub coordination handoffs.
- Measure human relays, copied context, duplicate work, source-fetch failures, unclear ownership, and time-to-owner-decision.
- Record every fallback to Slack, Discord, email, or private agent chat and why it happened.
- Delete unused states, fields, controls, and abstractions before adding another workflow.

Exit condition: controlled cases require zero human context relays and cause zero repeated external actions; a returning person can identify result, owner, evidence, and next action without asking for a recap.

## 11. Test strategy

### Domain contract

- deterministic replay
- duplicate event ID and idempotency-key handling
- room messages may address a human or agent without creating work or granting authority
- a message can be promoted into linked accountable work without copying its context
- valid and invalid state transitions
- read-only work without claims
- contested writes without claims rejected
- claim cannot manufacture permission
- only accountable member reports completion
- completion is not verification
- only designated independent verifier verifies
- exact evidence-version match required
- verification failure blocks the current version without losing its receipt
- later PASS cannot clear an unresolved blocker
- late verification for a known older completion is retained as history without changing the current version or gates
- approval denied before required verification
- only the designated human decision-maker records the v0 decision
- approval remains a decision about completed work rather than a new work state
- changes requested blocks the current version and requires accepted new direction
- approved completed work requires the explicit blocked → accepted → working → completed rework path before replacement
- a replacement result cannot inherit an older PASS or approval
- stale expected revision leaves the event log and projection unchanged
- conflicting duplicate event or idempotency keys are rejected

### API integration

- actor identity cannot be overridden in the body
- non-member cannot read or mutate Room data
- expected-version conflicts return current projection
- transaction appends event and projection atomically
- outbox dispatch resumes after failure
- stream reconnect resumes after event cursor
- duplicate webhook delivery does not duplicate Room events
- invalid webhook signature rejected

### End-to-end fixture

Given the public #167 coordination fixture and permitted source links, a newly authorized agent must derive:

- current Work Item state
- accountable member
- active claim or none
- latest exact evidence
- latest verification result and actor
- unresolved owner gate
- next action and responsible member

Pass means all answers match the replayed Room projection with zero manual context paste.

### Accessibility and responsive behavior

- keyboard navigation and visible focus
- labeled forms and controls
- live-region status announcements
- sufficient color contrast without color-only meaning
- 200% text zoom and narrow viewport reflow
- touch targets and no unintended horizontal scroll

## 12. Product measurements

Primary:

- required human context relays per completed loop
- repeated external actions per loop
- duplicate work attempts detected before execution
- percentage of completion receipts with resolvable exact evidence
- percentage of required verifications performed against the exact version
- percentage of returning users who correctly identify the next decision without requesting a recap

Secondary:

- time from owner steer to accepted accountability
- time from completion receipt to verification
- time from verification to owner decision
- fallback rate to another communication surface
- blocked items with a named next responsible member

Do not optimize message volume, number of agent turns, or autonomous activity. More activity is not more value.

## 13. First implementation review checklist

- The UI opens on the working Room, not a marketing page.
- The Work Item, not chat, is the authoritative collaboration spine.
- The actor, outcome, evidence version, verification, gate, and next action are visible.
- Read-only work never asks for a write claim.
- A claim cannot grant write capability.
- Accountable completion and independent verification remain separate.
- Failed verification is visible and recoverable.
- Approval is a distinct version-bound decision event, not a work state or external action.
- Duplicate delivery is harmless.
- Browser-only persistence is labeled honestly and not confused with server durability.
- No merge, deployment, or production claim is implied by the prototype.

## 14. Immediate next handoff

After this branch passes CI:

1. Instinct independently reviews the exact implementation SHA against the domain contract and first-loop fixture.
2. Codex addresses only concrete contradictions or failures.
3. The owner reviews the separate spec and implementation PRs in sequence.
4. Nothing is merged or deployed until the owner makes that explicit decision.
