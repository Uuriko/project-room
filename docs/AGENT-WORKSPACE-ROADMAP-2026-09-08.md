# Agents working directly in Project Room

Roadmap with a locally implemented lifecycle foundation · September 8, 2026

The next product step is a shared working environment with persistent context,
tools and accountable progress. An agent should be able to arrive, understand the
room, find useful work, coordinate, produce evidence and hand off—without making
the human UI complicated or asking permission for every ordinary authorized step.

The principle: **broad initiative inside a clear standing charter**. Being able to
call a tool is not permission to spend, publish, change access or contact people.
Conversely, an owner-approved charter should let an agent act without repeated
approvals for every read, draft, test or permitted task transition.

## Current foundation

- One canonical room, membership, event and work-state model across browser/API.
- Owner-issued managed agent identities, private setup, expiry, rotation and stop.
- Local MCP access check, discovery, selected read, draft return and ten explicit
  work/claim/review operations, shared with the direct client. See the
  [lifecycle implementation](AGENT-WORK-LIFECYCLE.md); this is local, not deployed.
- Work accountability, scoped claims, evidence/version-aware reviews and owner gates.
- Notify-only local watcher; selected portable tasks and manually reviewed returns.

Not yet present: hosted AI execution, isolated per-attempt environments, remote
OAuth MCP, resource budgets, automatic agent scheduling, verified vendor identity,
provider integrations or a fully autonomous multi-agent manager.

## 1. Let an agent operate the existing work lifecycle

Implemented locally: explicit tools for the existing service operations—propose,
accept, acquire/release scope, start, block/resolve, complete, verify and supersede.
An existing designated reviewer becomes the next actor after completion; no new
review-request event or parallel MCP task database was added. Human-only decisions
remain unavailable to agents. Existing permissions are unchanged.

Every mutation returns the original operation's applied revision, event ID and
exact-retry status, then points to an explicit current-work read for the actual
next actor. A saved write is not hidden by a failed automatic refresh; an old
receipt never claims to describe current ownership. Mutations require caller-held
stable operation IDs; interrupted actions reconcile rather than guessing. Claims must
be acquired before editing shared resources, not merely before reporting completion.

Add bounded work discovery by capability and permitted scope: “What can I help
with?” returns eligible work and why, without silently assigning or starting it.
An agent may propose unassigned work when its charter permits; joining a private
room still requires a valid invitation/grant. Public opportunities can be discoverable
without making private room history discoverable.

First acceptance gate: two different agents discover their respective assignments,
claim disjoint scopes, encounter one deliberate conflict, coordinate and finish a
draft/review cycle without duplicate commands or a fabricated human approval.

## 2. A connected workspace for each work attempt

One work item can have multiple immutable attempts. Each attempt records the
performing identity, charter/grant version, selected context digest, source repo/ref,
environment ID, lease/fencing token, deadline, budget and reported outcomes.

Connect an isolated branch/worktree/container per write attempt. Give it only the
selected project context and scoped tools. Keep provider/repository credentials
outside model text; where feasible use short-lived tool grants through the server.
Separate directories under one OS user are useful organization, not secret isolation.

The room becomes the place to inspect files/diffs/artifacts, run authorized tests,
see blockers and review results. Dasha Compute can be one execution backend under
this contract, not a second task/authority system. Start with a deterministic fake
runner; prove duplicate dispatch, cancellation and restart before paid execution.

## 3. Delegation and coordination that survives disconnects

Agents should be able to ask another agent for help, propose a subtask, request a
review, publish a scoped intent and transfer a handoff. Require a delegation grant:
child authority cannot exceed the parent scope, budget or deadline, and the
accountable human remains visible. Track parent/child causation without confusing
a helper's reported result with independently verified evidence.

Use leases plus monotonically increasing fencing tokens for execution ownership.
Every write checks the token; an expired worker cannot resume stale authority after
another worker takes over. Persist attempt/dispatch records before outside effects.
Exactly-once claims apply to our own committed commands, not arbitrary provider
side effects; unknown external outcomes need reconciliation.

## 4. Reliable attention, without perpetual chatter

Add subscriptions for assignment, mention, review request, blocker resolution and
relevant context change. Events have stable IDs, acknowledgement/checkpoint rules,
bounded retries and coalescing. Idle agents wait instead of repeatedly reading the
whole room. Owners can choose which events wake which runtime and at what cost.

Make contact evidence explicit and generation-bound. Distinguish key issued,
access checked, last contact, running (reported), blocked and stop acknowledged.
Expiry of a lease/contact window is not proof that an outside process stopped.
Pause new dispatches, revoke access and request runtime cancellation separately.

## 5. Persistent memory with sources and boundaries

Keep a concise room charter, decisions, current plans, definitions and artifact
references that both humans and agents can inspect. Distinguish shared room facts,
private agent scratch work and account-level preferences. Do not dump the entire
conversation into every task or promote pasted instructions into policy.

Attach provenance and versions to context. Let agents ask targeted questions and
propose corrections. Human-approved policy changes are explicit events; suggestions,
web content, messages and artifacts never silently become new tool authority.
Expose useful progress and evidence, not private internal reasoning transcripts.

## 6. Standing autonomy profiles, including a genuinely useful free path

Start with understandable profiles: read/chat, contribute, reviewer, and a later
coordinator. Reveal advanced policy only when selected: allowed projects/resources,
types of work, delegation, wake events, spend ceilings and actions requiring review.
Allow owners to tighten or revoke the grant without removing historical attribution.

A self-directed agent can offer help, claim eligible work and contribute under its
existing grant. It cannot self-approve broader access. Model/provider choice is
separate from Room capability: bring-your-own agents retain a strong free workflow;
hosted help is optional, metered and visibly bounded. Never start consuming a user's
unused quota merely because it is available.

## Lightweight human surface

Keep chat, work and People & agents as the default. Connecting an agent reveals its
setup; assigning work reveals an optional workspace; a blocker or review request
reveals the decision needed. Advanced tools, logs, policy and budgets live under
contextual details. The human should usually see a result, a preview or one concise
question—not a stream of tool calls.

## Build order and release gates

1. Finish native host acceptance checks and MCP lifecycle parity with the current
   service, including genuine separate-agent coordination and strict receipts.
2. Introduce versioned charters and attempt records with migration/recovery tests.
3. Add isolated local execution through a fake-runner-tested dispatch contract.
4. Integrate Dasha/repository tools with explicit resource and cost authorization.
5. Add event-driven wakeups, delegation and broader autonomous work discovery.
6. Add remote MCP/auth only with native hosted-client consent/revocation tests.

Each milestone needs a useful successful journey, an interrupted/restarted journey,
a denied/stale-authority journey and a human-readable recovery path. Avoid expanding
permissions or pretending an older database/runtime is a safe fallback. Provider
credentials, budget and publication are separate authorizations—not implied by
the existence of a Room connection.
