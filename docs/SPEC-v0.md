# Project Room v0

Proposed contract, 2026-09-05. Spec and docs only until further owner go on implementation.

## Product and first users

Help a small team and its agents finish one project without the operator forwarding context between tools. The first demonstration includes two authenticated people, an executor, and an independent verifier in one Room. A Room is the project in v0; a separate one-to-one Project object adds no useful behavior.

The [first workflow](./FIRST-WORKFLOW.md) defines the screen and review demonstration. Conversation stays conversational. Only accepted work needs an assignment; asking a question does not require creating a task.

## One object model

| Object | Required meaning |
| --- | --- |
| Room | Project title, goal, membership, and explicitly shared sources. |
| Member | Authenticated human or agent identity, display name, and explicit grants in this Room. An agent also has an accountable human. |
| Work Item | Intended outcome, accountable member, current work state, revision, completion requirements, designated verifier if required, and any owner decision needed. |
| Artifact | A result attached to a Work Item with a resolvable source and exact version, such as a URL plus full commit SHA. |
| Event | A message, assignment, attempt, completion report, check, or decision with an ID, actor, time, and relevant source, artifact, and causal reference. |

Messages are Events. Tasks are Work Items. Receipts, acceptance, verification, and decisions are Events on the same Work Item. No separate Outcome table, signed-receipt system, or general Policy engine is required.

Persist a current view and its supporting events together. Work Item mutations check the expected revision; a stale update fails without partially changing the view or adding a misleading event. A retry with the same source, Room, event ID, and payload returns the existing event; conflicting reuse is rejected. These rules describe the required behavior, not an implemented storage layer.

## Membership and permissions

- The Room owner invites or removes members and grants explicit capabilities.
- Every member may read the material shared with the Room and participate in its conversation. Assignment and action capabilities are granted separately.
- The second human in the first demo may read, discuss, and propose. Recording an owner decision requires an explicit grant as that Work Item's human decision-maker.
- An assigned accountable member may accept, report progress, report completion, or mark work blocked within its accepted scope. An authorized executor may also be that accountable member.
- The designated verifier records independent checks. Owner decisions are recorded by the designated human decision-maker.
- A handoff to a verifier already designated in the assignment needs no human relay. Creating a new assignment or expanding its scope requires the corresponding grant.
- Authenticate actors from their credentials. Names, message prefixes, and text claiming approval do not confer capabilities.
- Source material must be permitted for the Room's whole audience before it enters shared context. Private sources and their derived summaries stay in a separately restricted context. Recheck access before reading sources or invoking tools after a restart.

The first demo uses one shared access scope. Enterprise roles, organization-wide search, SSO, and external guests are outside v0.

## Work, checks, and decisions

Use one work-state vocabulary: `proposed`, `accepted`, `working`, `blocked`, `completed`, `superseded`. Acceptance means responsibility was accepted; working means an attempt began. See [events and fixtures](./EVENT-FIXTURES.md) for the allowed changes.

Completion records a result. Verification and approval are separately derived from events for that exact result version, rather than additional work states. A pending decision is an unanswered requirement, not an approval event. Changing the result cannot carry an old PASS or approval onto the new version.

The visible card answers: what is the outcome, who is responsible, what evidence exists, and what happens next? A human approval recorded in the Room does not itself merge code or publish anything.

## Runtime and recovery

Use existing agent runtimes and one working connection first. The connection must receive accepted work and return evidence without the operator pasting messages. Manual fixture entry can illustrate the design but cannot pass the working handoff demonstration.

Persist task state and source references independently of any provider's private session. Reconnect from recorded context; do not promise restoration of unrecorded process state. Mark an unavailable worker and preserve its last confirmed step. If an external action's outcome is unknown, show the uncertainty and check the source before retrying it.

Replaying stored events rebuilds the Room view only. It never reissues external actions. The first review workflow is read-only and needs no write lease. Claims are required only when a later write feature actually coordinates a contested resource; an external repository is not locked by a Room record.

## Acceptance and exclusions

The first build must demonstrate the shared screen, a second person joining without a recap, an executor-to-verifier handoff, restart recovery, and exact-version evidence. Walk the cases in [events and fixtures](./EVENT-FIXTURES.md).

Evaluate five suitable handoffs for required human relays, repeated actions, and whether each participant can identify the next action. Record fallbacks to existing tools; do not ban those tools to force adoption.

Defer automatic skill generation, automatic benchmarks or model routing, bot marketplaces, chat bridges, calls, and community features. The first implementation needs conversation, work state, evidence, and one useful handoff.
