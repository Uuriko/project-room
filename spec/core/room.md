# Room

Draft 0.1.0. Normative words are RFC 2119. See [the draft index](../README.md).

A room is one shared project: a membership, a capability list on each member, and an ordered event log. Work items, claims, and messages are facts in that room. They are not a second room.

This file has two layers. The first (Members, Sponsor, Event log) is the implemented model: normative statements cite the modules that implement them. The second (The v0 product model) absorbs `docs/SPEC-v0.md` in full — the initial product contract of 2026-09-05 — and states the product intent the implementation serves. Where the v0 text describes required behavior the current server does not implement in that form, the v0 section says so; the implemented sections govern. `docs/SPEC-v0.md` is removed; this file is the model's only home.

## Members

A member MUST have a kind of `human` or `agent`. Any other kind is rejected. Source: `src/events.js` (`member.added` requires `human` or `agent`).

An agent member MUST have an accountable human. When the add event omits `accountableHumanId`, the server stores the room owner's member id. A human member's accountable human is that member. Source: `src/events.js`.

The stored authority for what a member may do MUST be the member's `permissions` list, not a role name. The permission names are `steer`, `decide`, `manage_members`, `manage_claims`, `accept_work`, `complete_work`, `verify`, `write_external`, and `invite_member`. Source: `src/events.js` (`PERMISSIONS`).

Invitation role names (`moderator`, `member`, `guest`) MUST be presets that copy a fixed permission list onto the member at invite time. A later change to the preset MUST NOT rewrite members already stored. Source: `src/events.js` (`INVITATION_ROLE_POLICIES`).

Agent access profiles MUST map to fixed permission sets:

| Profile | Permissions |
| --- | --- |
| `chat` | none |
| `contribute` | `accept_work`, `complete_work` |
| `review` | `verify` |
| `collaborate` | `steer`, `accept_work`, `complete_work`, `verify` |

A request MUST NOT widen a profile by sending extra permission names. Source: `server/agent-connections.mjs` (`agentAccessProfiles`).

The room owner, or a member the owner grants, administers membership. An agent MUST NOT receive `manage_members` or `decide` except by an explicit owner grant, which the server marks `delegatedAdmin`. Source: `src/events.js`.

## Sponsor

A sponsored agent connection MUST record `sponsor_account_id` and `sponsor_member_id`. The sponsor row stays valid only while that sponsor is the human room owner, is active, still holds `manage_members`, and still matches the stored sponsor revision. Source: `server/agent-connections.mjs`.

The connection history MUST be retained. Disconnect is final. Source: `server/agent-connections.mjs` (the `agent_connections` triggers).

## Event log

Room facts that go through the command path MUST be appended as events. Each event has an id, a type, an actor, a timestamp, and data. The room MUST assign `sequence` as one more than the room's current sequence, and the pair `(room_id, sequence)` MUST be unique. Source: `server/store.mjs` (table `events`, insert on the command path).

A reader MUST ask for events strictly after a sequence. The query name is `after`. `afterSequence` is not a cursor. Source: `docs/openapi.yaml` (`/api/rooms/{roomId}/events`), `server/mcp-hosted-tools.mjs` (`room_list_events`).

A correction MUST be a later event. The command path does not update an earlier event body.

Event type names live in `src/events.js` (`EVENT_TYPES`). Board claim changes use `work_claim.updated`. Work-item scope reservations use `claim.acquired`, `claim.released`, and `claim.renewed`. Those are different facts. See [claim](claim.md).

## The v0 product model

Absorbed from `docs/SPEC-v0.md` ("Project Room v0", initial product contract, 2026-09-05). The former spec-only hold recorded there is superseded; current development follows the team workflow (`archive/docs/history/WORKFLOW.md`).

### Product and first users

The product helps a small team and its agents finish one project without the operator forwarding context between tools. The first demonstration includes two authenticated people, an executor, and an independent verifier in one Room. A Room is the project in v0; a separate one-to-one Project object adds no useful behavior.

The first workflow (`archive/docs/history/FIRST-WORKFLOW.md`) defines the screen and review demonstration. Conversation stays conversational. Only accepted work needs an assignment; asking a question does not require creating a task.

### One object model

| Object | Required meaning |
| --- | --- |
| Room | Project title, goal, membership, and explicitly shared sources. |
| Member | Authenticated human or agent identity, display name, and explicit grants in this Room. An agent also has an accountable human. |
| Work Item | Intended outcome, accountable member, current work state, revision, completion requirements, designated verifier if required, and any owner decision needed. |
| Artifact | A result attached to a Work Item with a resolvable source and exact version, such as a URL plus full commit SHA; producer/provenance is recorded when known and explicitly unknown otherwise. |
| Event | A message, assignment, attempt, completion report, check, or decision with an ID, actor, time, and relevant source, artifact, and causal reference. |

Messages are Events. Tasks are Work Items. Receipts, acceptance, verification, and decisions are Events on the same Work Item. No separate Outcome table, signed-receipt system, or general Policy engine is required by v0. (Room today: the server has since grown a signed-evidence object for external completions and a board receipt projection — see [receipt](receipt.md). Those are additions to this model, not a second object model.)

Persist a current view and its supporting events together. Work Item mutations check the expected revision; a stale update fails without partially changing the view or adding a misleading event. A retry with the same source, Room, event ID, and payload returns the existing event; conflicting reuse is rejected. These rules describe the required behavior, not an implemented storage layer.

### Membership and permissions (v0 intent)

- The Room owner invites or removes members and grants explicit capabilities.
- Every member may read the material shared with the Room and participate in its conversation. Assignment and action capabilities are granted separately.
- The second human in the first demo may read, discuss, and propose. Recording an owner decision requires an explicit grant as that Work Item's human decision-maker.
- An assigned accountable member may accept, report progress, report completion, or mark work blocked within its accepted scope. An authorized executor may also be that accountable member.
- The designated verifier records independent checks. Owner decisions are recorded by the designated human decision-maker.
- A handoff to a verifier already designated in the assignment needs no human relay. Creating a new assignment or expanding its scope requires the corresponding grant.
- Authenticate actors from their credentials. Names, message prefixes, and text claiming approval do not confer capabilities.
- Source material must be permitted for the Room's whole audience before it enters shared context. Private sources and their derived summaries stay in a separately restricted context. Recheck access before reading sources or invoking tools after a restart.

The stored form of these grants is the `permissions` list in Members above; that section governs where the two differ in mechanism. The first demo uses one shared access scope. Enterprise roles, organization-wide search, SSO, and external guests are outside v0.

### Work, checks, and decisions

The v0 work-item vocabulary is: `proposed`, `accepted`, `working`, `blocked`, `completed`, `superseded`. Acceptance means responsibility was accepted; working means an attempt began. See `docs/EVENT-FIXTURES.md` for the allowed changes. This vocabulary belongs to work items; it is not the board claim state machine, whose seven states are specified in [claim](claim.md). Neither vocabulary renames the other.

Completion records a result. Verification and approval are separately derived from events for that exact result version, rather than additional work states. A pending decision is an unanswered requirement, not an approval event. Changing the result cannot carry an old PASS or approval onto the new version.

The visible card answers: what is the outcome, who is responsible, what evidence exists, and what happens next? A human approval recorded in the Room does not itself merge code or publish anything.

### Runtime and recovery

Use existing agent runtimes and one working connection first. The connection must receive accepted work and return evidence without the operator pasting messages. Manual fixture entry can illustrate the design but cannot pass the working handoff demonstration.

Persist task state and source references independently of any provider's private session. Reconnect from recorded context; do not promise restoration of unrecorded process state. Mark an unavailable worker and preserve its last confirmed step. If an external action's outcome is unknown, show the uncertainty and check the source before retrying it.

Replaying stored events rebuilds the Room view only. It never reissues external actions. A schema upgrade may establish an immutable repaired-projection checkpoint so historical events remain byte-for-byte append-only while later events replay under stricter rules. The first review workflow is read-only and needs no write lease. Claims are required only when a later write feature actually coordinates a contested resource; an external repository is not locked by a Room record.

### Acceptance and exclusions

The first build must demonstrate the shared screen, a second person joining without a recap, an executor-to-verifier handoff, restart recovery, and exact-version evidence. Walk the cases in `docs/EVENT-FIXTURES.md`.

Evaluate five suitable handoffs for required human relays, repeated actions, and whether each participant can identify the next action. Record fallbacks to existing tools; do not ban those tools to force adoption.

Defer automatic skill generation, automatic benchmarks or model routing, bot marketplaces, chat bridges, calls, and community features. The first implementation needs conversation, work state, evidence, and one useful handoff.

### Adjacent product: Compute bridge (Phase 1+)

Phase 0 is unchanged. Project Room and Dasha Compute stay separate products. A later bridge may let a Work Item POST a job to `compute/api` and record a Receipt Event. See `archive/docs/history/FOLD-COMPUTE-ROOM.md` and `archive/docs/history/BRIDGE-COMPUTE.md`.

### Adjacent contract: Contribution ledger (docs now; derived rollup 0.5+)

Phase 0 is unchanged. Contribution is a read-model over existing completion, verification, decision, and Artifact facts — not a second product or a disconnected scoreboard. v0 of the ledger is visible share weights only; no auto-payout. Message volume is not value. See `archive/docs/history/CONTRIBUTION-LEDGER.md`. The isolated contribution-rollup package was removed from this repository. Designs and fixtures coordinate in the room (issue #266 is frozen; see `docs/ROOM-COORDINATION.md`).

## Room today

The room's own `kind` is `personal` or `organization` (`src/events.js`, `ROOM_KINDS`). That is the room type, not the member kind.

Share-link guests and guest-agent links are membership paths (`server/share-links.mjs`, `server/guest-agent-links.mjs`). They do not add a third member kind. A guest agent is still `kind: "agent"`.

Import of a room replaces that room's event rows as a whole (`server/store.mjs`, room import). That is a restore of a sequence, not an edit of one event.

The v0 product model above and the implemented model at the top of this file share the event log specified in Event log. Where the v0 text and the implemented sections disagree on mechanism, the implemented sections govern; where they disagree on product intent, the v0 section is the record of that intent.
