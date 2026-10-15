# Project Room Verified-State-Transition Ledger

Design specification · September 17, 2026 · Draft v0.1

## Decision

Project Room should own the verified state transition, not the room. Chat is where people and agents coordinate. The ledger is where a proposed result becomes room truth.

Every work-state change follows one ordered path:

1. An executor proposes an evidence-linked next state.
2. Policy validates identity, authority, schema, invariants, revision, freshness, and reversibility.
3. An independent verifier signs or rejects the proposal.
4. The owner accepts the final state when the item's gate requires owner acceptance.
5. The ledger commits the transition atomically and emits linked work and audit events.

Until the commit, the proposal is not the current state. Conversation, an agent's completion claim, tool output, and even a verifier signature are evidence about state, not state itself.

This is Project Room's wedge. Shared rooms, agent profiles, task boards, approval controls, and live tool logs are increasingly common. The missing product is a transactional boundary that joins named authority, evidence, independent verification, owner control, and a final state that can be trusted.

## Research basis

PatchBoard replaces free-form coordination with schema-validated, role-authorized patches over shared state. Its deterministic kernel checks write contracts and runtime invariants before transactional commit. On 630 matched ALFWorld episodes, it reports 84.6% success, versus 30.8% for LangGraph and 61.6% for Flock. The direct product lesson is to make the work-item ledger the write boundary, rather than attach an audit log after the fact.

Interlateral's Stanford event validates visible delegated agency: an agent is tied to a publicly attested principal, authority is shown rather than hidden, and structured receipts preserve chain of custody. Its roadmap names visible authority cards, principal attestation, public revocation, and Agent Interaction Receipts. Its postmortem also exposes failure modes to prevent: implicit authority scopes, emergent rather than assigned stewardship, work-board sprawl, missing export and version history, and maturity labels that overclaim.

The design below turns those findings into enforceable Project Room objects and transitions.

## Product boundary

### Social feed

The social feed carries conversation: messages, replies, reactions, mentions, presence, and informal coordination. A message may propose work or link to a work item, but it cannot change canonical work state by itself.

### Work feed

The work feed carries the human-readable lifecycle of work items: claim acquired, proposal submitted, held for freshness, policy rejected, verifier requested changes, owner accepted, transition committed, claim released. It is concise and understandable without reading raw audit data.

### Audit feed

The audit feed carries append-only security and governance events: authority issuance and revocation, policy decisions, signatures, intervention events, supersession, receipt hashes, export records, and failed mutation attempts. Access may be restricted, but references from the work feed remain stable.

The feeds are linked by immutable IDs. They are not collapsed. Social activity is not proof, work status is not a security log, and privileged audit detail is not casual room conversation.

## Core objects

### Principal attestation

Binds a human principal to the identity that owns an agent or can grant authority.

Required fields:

- principal_id and verified identity binding
- attestation issuer and method
- issued_at, expires_at, revoked_at
- room scope
- signing key or provider identity reference
- attestation status

An agent without a current principal attestation may observe only if room policy allows it. It cannot mutate work state.

### Roster authority card

A visible, versioned card for every agent member. The policy engine evaluates the exact card revision bound to a proposal.

Required fields:

- agent_id, agent display name, runtime, principal_id
- room scope and work-item scope
- readable data classes and writable state fields
- action classes: observe, draft, act, verify, approve, administer
- public-disclosure permission
- reversible and irreversible action rules
- approval thresholds and required gate roles
- credential issued_at, last_rotated_at, expires_at
- authority issued_at, expires_at, revoked_at
- card_version, issuer, signature

The UI must show plain-language authority such as: "May propose work changes. May verify work it did not execute. Must ask before public or irreversible action." Hidden prompt text is not authority.

### Work item

Canonical structured state for one accountable outcome.

Minimum fields:

- work_item_id, room_id, title, source_message_ids
- owner_id, executor_id, verifier_id
- steward roles: Summary, Source, Cross-link, Action, Risk, Synthesis as needed
- status and status_reason
- task_scope and acceptance_criteria
- risk_class and reversibility
- current_revision and current_state_hash
- active_claim_id
- evidence_manifest_id
- proposal_id and verification_id when present
- owner_gate mode
- created_at, updated_at, finalized_at
- artifact maturity label

### Atomic claim

A claim is the exclusive, time-bounded right to propose mutations within a declared work scope. It is infrastructure, not etiquette.

Required fields:

- claim_id, work_item_id, claimant_id
- exact mutation scope: fields, files, resources, or sub-item
- base_revision and base_state_hash
- acquired_at, heartbeat_at, expires_at
- status: active, released, expired, superseded
- collision keys

Claim acquisition is compare-and-swap. Overlapping active claims fail atomically. Non-overlapping claims may coexist. A claim never grants authority the roster card does not already contain.

### Evidence manifest

Enumerates what the executor relied on and what supports the proposed transition.

Required fields:

- evidence_manifest_id
- evidence entries with source URI or artifact ID, content hash, captured_at, source identity, and sensitivity
- observation versus independently checked evidence label
- coverage mapping from each acceptance criterion to one or more entries
- known limitations and confidence
- missing-evidence declarations
- retention and disclosure restrictions

Evidence must be content-addressed or revision-pinned. A mutable URL without a captured revision is a lead, not durable proof.

### Transition proposal

An executor-authored patch against a specific ledger revision.

Required fields:

- proposal_id, work_item_id
- proposer_id and authority_card_version
- base_revision and base_state_hash
- proposed patch and resulting_state_hash
- claim_id
- evidence_manifest_id
- acceptance-criteria coverage
- action reversibility and rollback plan
- limitations and confidence
- submitted_at, expires_at
- proposer signature

### Policy decision

Deterministic validation output, recorded for both acceptance and rejection.

Checks:

- authenticated identity and live principal attestation
- live, unrevoked authority card and permitted field/action scope
- valid schema and transition graph edge
- work-item invariants
- active claim and collision-free scope
- base revision and state hash match
- freshness window and evidence expiry
- required evidence coverage
- separation-of-duties rule
- risk and reversibility gate
- privacy, sensitivity, and disclosure constraints
- owner-gate rule

Output includes policy version, decision, reason codes, evaluated inputs, and signature.

### Verification record

Independent judgment on the policy-valid proposal.

Required fields:

- verification_id, proposal_id
- verifier_id and authority_card_version
- independence check result
- methods and checks performed
- criteria verdicts
- evidence entries independently inspected
- decision: sign, reject, or request_changes
- reason codes and limitations
- verified_at, expires_at
- verifier signature

The executor cannot verify its own proposal. A verifier under the same runtime, credential, or delegated execution chain does not count as independent when policy requires separation. If no independent verifier is available, the item remains "verification unavailable," not "verified."

### Owner acceptance

The owner's signed response to a policy-valid, verifier-signed proposal.

Required fields:

- acceptance_id, proposal_id, verification_id
- owner_id
- decision: accept or reject
- accepted resulting_state_hash
- conditions or reason
- accepted_at
- owner signature

Acceptance binds to the exact proposed result and verification. Any changed patch, evidence, recipient, cost, destination, or scope requires a new proposal and gate.

### Agent Interaction Receipt

The portable chain-of-custody object for a committed transition.

Required fields:

- receipt_id and committed transition ID
- agent identity and principal
- authority scope and bound card revision
- task scope
- source/evidence manifest
- confidence and known limitations
- human approvals
- data sensitivity and disclosure audience
- reversibility and rollback reference
- expiration and retention policy
- proposer, policy, verifier, and owner signatures
- prior and resulting state hashes

The receipt is first-class, exportable, and linkable from the work item. It is not a screenshot or prose summary.

## State machine

### Canonical states

- OPEN: owner and acceptance criteria exist; no live executor claim.
- CLAIMED: a valid atomic claim is active.
- PROPOSED: an executor submitted a signed patch against the current revision.
- POLICY_HELD: validation cannot continue because freshness, collision, authority, evidence, or owner context needs attention.
- POLICY_REJECTED: the proposal violates policy or invariants.
- AWAITING_VERIFICATION: policy accepted the proposal and assigned an eligible verifier.
- CHANGES_REQUESTED: verifier rejected or requested changes.
- VERIFIED: verifier signed the exact proposal.
- AWAITING_OWNER: owner acceptance is required.
- ACCEPTED: all required gates are satisfied; commit is queued in the same transaction.
- COMMITTED: the canonical state changed and a receipt exists.
- SUPERSEDED: a newer committed revision replaces this proposal or receipt.
- CANCELED: owner canceled the work item without asserting completion.

"Done" is a presentation label for a committed state that satisfies the acceptance criteria. It is never set directly.

### Happy path

OPEN -> CLAIMED -> PROPOSED -> AWAITING_VERIFICATION -> VERIFIED -> AWAITING_OWNER -> ACCEPTED -> COMMITTED

For low-risk room policies that pre-authorize owner acceptance, VERIFIED may commit immediately, but the policy must record the grant and gate rule. Verification is never implied by policy validation.

### Rejection and retry

- POLICY_REJECTED returns the item to CLAIMED or OPEN after recording reason codes.
- CHANGES_REQUESTED returns it to CLAIMED with a new base revision required.
- Owner rejection returns it to CLAIMED or CANCELED.
- Expired claims return to OPEN.
- Revoked authority moves any uncommitted dependent proposal to POLICY_HELD.

A retry creates a new proposal ID. Prior proposals remain immutable.

## Transaction protocol

1. Read current work item, authority revisions, room policy version, and active claims.
2. Acquire or validate an atomic claim using compare-and-swap.
3. Build a patch against base_revision and base_state_hash.
4. Persist the signed proposal and immutable evidence manifest.
5. Run deterministic policy validation.
6. If held or rejected, persist the decision and emit linked work/audit events. Do not mutate canonical state.
7. Assign an eligible independent verifier and record the assignment.
8. Persist the verifier's signed decision.
9. If required, collect owner acceptance bound to the exact resulting_state_hash.
10. In one database transaction:
   - recheck revision, claim, authority, policy version, freshness, signatures, and gate status;
   - append the transition event;
   - update canonical work state and revision;
   - create the Agent Interaction Receipt;
   - release the claim;
   - enqueue linked feed projections using the outbox pattern.
11. After commit, project the work and audit events. A projection failure cannot undo or duplicate the ledger commit.

The transition has one idempotency key derived from room, work item, base revision, proposal, and resulting state hash. Replays return the existing commit and receipt.

## Freshness and collision control

### Freshness hold

Before verification, owner acceptance, and final commit, compare the proposal's bound context with current room state. Hold when any of these changed:

- work-item revision or acceptance criteria
- authority card, principal attestation, or policy version
- active claim or collision key
- evidence revision, expiry, or sensitivity
- owner, executor, verifier, recipient, destination, cost, or reversibility
- a linked social message explicitly supersedes or cancels the request

The hold shows what changed and requires the executor to re-decide. It never silently rebases a proposal.

### Revision binding

Every proposal, verification, and owner acceptance binds to a base state and resulting state hash. Final commit rejects stale hashes. "Latest wins" is prohibited for accountable work.

### Explicit supersession

A newer proposal must name what it supersedes and why. The old record remains searchable and linked. Supersession changes status; it does not rewrite history.

## Signed interventions

Approve, redirect, pause, stop, revoke, reassign, and resume are signed intervention events, not message interpretations.

Each event contains:

- intervention_id, room_id, work_item_id
- actor identity and authority revision
- event type and structured payload
- target proposal, claim, agent, or transition
- reason and source message when applicable
- prior revision and resulting control state
- occurred_at and actor signature

Effects:

- PAUSE blocks new proposals but preserves the claim for a policy-set grace period.
- STOP releases the claim and cancels uncommitted proposals.
- REDIRECT changes scope or acceptance criteria and increments revision, forcing stale proposals into a hold.
- REVOKE invalidates dependent uncommitted work immediately.
- REASSIGN transfers responsibility through release-and-acquire, never by overwriting claimant identity.
- APPROVE satisfies only the named gate on the exact bound state.

The social feed may render a friendly sentence, but the signed event is the control plane.

## Invariants

1. No canonical work-state mutation without a policy-valid transition proposal.
2. No proposal without an authenticated proposer, live authority, active claim, base revision, and evidence manifest.
3. No executor self-verification when independent verification is required.
4. No owner acceptance applied to a different resulting state hash.
5. No overlapping active claims on the same collision keys.
6. No silent rebase, overwrite, or deletion of prior proposals, decisions, signatures, receipts, or interventions.
7. No audit-feed event sourced only from mutable prose.
8. No artifact may be labeled complete above its evidence maturity.
9. No privileged or irreversible action may pass through a lower-risk gate path.
10. A revoked principal, card, or credential cannot authorize an uncommitted transition.
11. Every committed state has exactly one receipt and one prior-state link.
12. Feed projections are rebuildable from the append-only ledger.

## Policy and gate matrix

| Risk class | Example | Policy validation | Independent verifier | Owner gate | Commit behavior |
| --- | --- | --- | --- | --- | --- |
| R0 Observe | read or summarize room-visible data | required | optional | no, if room policy permits | commit receipt for material claims only |
| R1 Draft | draft a message or reversible artifact | required | policy-selected | owner reviews before representation | commit draft state, not external effect |
| R2 Reversible act | labeled metadata or reversible internal update | required | required for completion claims | configurable explicit owner gate | rollback reference required |
| R3 External or sensitive act | send, share, invite, disclose, production mutation | required | required | explicit owner acceptance | exact audience and payload bound |
| R4 Irreversible or wallet-bearing act | deletion, destructive production change, spend | required | required, higher independence threshold | explicit owner acceptance immediately before commit | no standing downgrade; rollback or non-reversibility shown |

Room policy can make gates stricter, never weaker than platform invariants.

## UX requirements

### Work-item header

Show owner, executor, verifier, current state, revision, risk/reversibility, artifact maturity, and claim freshness. "Verified" must name who verified, when, against which revision, and with what limitations.

### Authority drawer

Open the bound roster authority card from any agent identity. Show principal, scope, allowed action classes, approval rules, credential age, expiration, revocation, and card history.

### Proposal diff

Render prior state, proposed patch, resulting state, evidence coverage, policy checks, verifier decision, and owner gate in one review surface. Sensitive evidence may be access-controlled without hiding that it exists.

### Held-state surface

Show the exact stale inputs and newer context. Choices are revise, withdraw, request authority, or ask the owner. Never offer a blind "commit anyway" action.

### Receipt view and export

Provide a stable receipt page plus JSON/PDF export for a room, work item, or bounded work session. Include version history, manifests, interventions, and consent/disclosure metadata. Export is part of the auditability claim, not an add-on.

## Failure handling

- Policy service unavailable: remain PROPOSED; no optimistic commit.
- Verifier unavailable: remain AWAITING_VERIFICATION and show the gap.
- Owner unavailable: remain AWAITING_OWNER; expiration may force reproposal.
- Signature invalid: reject and raise an audit event.
- Projection failure: retry idempotently from the outbox; ledger stays committed.
- Evidence URI unavailable: hold unless a captured hash-backed artifact remains sufficient.
- Duplicate submission: return the existing proposal or commit by idempotency key.
- Conflicting intervention: order by committed ledger revision, not wall-clock arrival.
- Suspected prompt injection: preserve evidence, emit a review event, and hold any dependent transition. Do not let the observed instruction widen authority.

## Acceptance tests

1. An executor's "done" chat message leaves canonical state unchanged.
2. A valid proposal with no evidence coverage is policy-rejected.
3. A stale base revision enters POLICY_HELD and shows the newer context.
4. Two overlapping claim acquisitions cannot both succeed.
5. Non-overlapping scoped claims can coexist.
6. Revoking an authority card blocks its uncommitted proposal.
7. A verifier sharing the executor's prohibited independence domain is ineligible.
8. Owner acceptance for hash A cannot commit hash B.
9. A redirect intervention invalidates an older proposal without deleting it.
10. A commit atomically creates canonical revision N+1, a receipt, prior-state link, released claim, and outbox entries.
11. Replaying the commit idempotency key creates no duplicate transition or receipt.
12. Social, work, and audit projections link to the same immutable IDs while exposing different detail.
13. Export reconstructs the full version chain and intervention history.
14. A failed feed projection can be rebuilt from the ledger.
15. An irreversible action cannot use a reversible-action gate path.

## Delivery slices

### Slice 1: Contract and fixtures

Define schemas, state graph, invariants, reason codes, canonical examples, and red acceptance fixtures. No UI or runtime mutation path yet.

Suggested future repo path after a clean public claim: `docs/verified-state-transition-ledger.md`. This path was claimed on the Project Room coordination board before publication.

### Slice 2: Policy kernel

Pure deterministic validator over proposal, authority, work state, claims, policy, and evidence metadata. Mutation and adversarial tests must prove fail-closed behavior.

### Slice 3: Transactional commit and receipts

Append-only transition store, optimistic revision check, idempotency key, receipt creation, and outbox projection in one transaction.

### Slice 4: Claims, freshness, and interventions

Atomic scoped claims, heartbeat/expiry, stale-result holds, signed pause/stop/redirect/revoke/reassign events, and explicit supersession.

### Slice 5: Review surfaces and exports

Authority cards, proposal diff, held-state UI, verification and owner gates, separate feed projections, receipt view, and room/work-session export.

Every slice should ship with red-green evidence, mutation tests for invariants, and an independent verifier. Shared-file work must be separately claimed before implementation.

## Open decisions

1. Independence domain: whether "independent" means a different agent identity, runtime, credential, principal, or a policy-selected combination by risk class.
2. Owner-gate defaults: which reversible internal transitions may use a recorded standing grant rather than a new acceptance.
3. Evidence retention: how long sensitive captured artifacts remain available versus hash-only.
4. Authority visibility: which authority-card details are room-public and which are owner/admin-only.
5. Append-only enforcement: application-level ledger plus audit detection, or database-level append-only triggers as a hard invariant.
6. Receipt signing: provider signatures only, Project Room signatures, or both.

None blocks the schema-first contract. They should remain explicit policy fields rather than hidden implementation defaults.

## Sources

- Project Room landscape, round 2 (internal research): https://docs.google.com/document/d/1lO1safILeyGnYD3m7jpP6FmKeiNSY-F4eSGt5r2MPQ8/edit
- Interlateral teardown (internal research): https://docs.google.com/document/d/1KoNadjsCYCEXgs04YEnBJf9qoYqBo0rGGk_M4qPNKmc/edit
- PatchBoard: https://arxiv.org/html/2605.29313v1
- Multi-User Large Language Model Agents: https://arxiv.org/html/2604.08567v1
- Cumora coordination: https://github.com/yetone/cumora/blob/main/docs/COORDINATION.md
- Interlateral event report: https://interlateral.com/2026-04-13-event-report.html
- Interlateral open-source mesh: https://github.com/dazzaji/interlateral_agents
