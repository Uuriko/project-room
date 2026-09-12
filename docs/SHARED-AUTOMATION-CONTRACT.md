# Shared automations

Status: definition create/update/enable/accept/pause events are registered with schema32 writer fencing. Definitions and consent persist through replay/restart. Dispatch remains a pure-policy proposal: no registered dispatch, scheduler, UI, real routines or provider calls. This builds on native reply requests and request-run ownership, not hidden Work Items.

## First useful loop

Save a useful prompt as an automation. Choose a recipient, a manual or interval trigger, and visible limits. The creator enables this exact definition and the recipient accepts it. A permitted dispatch creates a normal room-visible reply request; its execution and answer use the existing bounded request-run path. People and agents can create, accept and pause under their own authenticated identities.

The creator owns the definition. The recipient controls acceptance of its scope. A creator cannot accept for the recipient, including when the creator is the room owner. Scope edits revoke both approvals and are refused while a previous request/run remains unresolved. Either participant or the human room owner can pause; resume requires fresh creator enablement and recipient acceptance. Pause prevents new dispatches; use Stop run to interrupt an existing execution. Neither operation rolls back outside effects.

The first dispatch interface requires the authenticated creator, not a scheduler impersonating them. A future background dispatcher needs an explicit delegated credential contract and audit attribution. Do not lend human credentials to the existing agent-only runner or silently broaden its identity checks.

Any membership-access change to either participant clears both consent flags and advances the automation revision if consent existed. Restoring membership cannot silently revive an accepted automation; fresh consent is required. This does not cancel an already-running request.

## Bounded delivery

- At most 100 definitions per room and 100 dispatches per definition in this initial bounded implementation. Edits retain consumed dispatch count.
- Intervals range from one minute to 30 days, anchored to a canonical UTC start time. Future starts do not fire early. Civil-time/daylight-saving scheduling is not part of this initial contract.
- Missed intervals collapse to the latest due slot. No replay storm or backlog burst after reconnect. A slot is consumed only by an atomically recorded dispatch.
- One outstanding request per automation. Cancelled/answered requests with a running, stop-requested or unconfirmed execution still block another dispatch. Missing predecessor state is not evidence of completion.
- Max runtime and output bytes accompany the accepted definition. The executor must enforce them when claiming/running the emitted request. These are not monetary budgets or provider access grants.
- Manual availability is not an automatic trigger. Generic polling must never dispatch manual definitions without an explicit user/agent action.
- Ordinary messages, answers and automation output do not trigger this first version. Event-triggered chains require explicit origin/lineage and hop limits later; no accidental self-trigger loop.

## Durable integration plan

1. Implemented definition lifecycle: `automation.created`, `.updated`, `.enabled`, `.accepted`, `.paused`, each with automationId and exact expectedRevision; create/update also require a validated definition. Schema32 rejects legacy collisions in event fields and projections and fences older writers. Definition/consent replay, restart, authentic identity, exact retry and genuine31 migration are covered by Node/Worker tests. Pause remains possible at pilot capacity, once per enabled/accepted definition. Consumed-slot durability still depends on step2.
2. Keep dispatch as a native `message.posted` reply request, with a strictly validated automation ID, exact definition/state revision and due slot. Derive prompt and recipient from the accepted definition, not caller overrides. Resolve command retries before current-state checks. In one transaction and replay step, record the message/request, advance automation revision/count/slot and link the emitted request. Validate message ID uniqueness against all messages, not only requests. Do not create a second synthetic request history whose opening event is not `message.posted`.
3. Add authenticated read/preview and mutation tools for humans and agents. Return versioned selected definition, consent, remaining budget, blocking request/run and next due slot without credentials. Preview must not consume a slot or create a request. Verify exact receipts and account-switch isolation.
4. Build a compact Automations view: title, recipient, trigger, consent/paused state, remaining runs and last result. Short actions: Enable, Accept, Pause, Run. Show scope and limits before consent. Native linked requests provide run history and existing Stop controls. Do not claim a live schedule until a dispatcher exists.
5. Implement a bounded opt-in dispatcher using the creator's explicitly authorized identity. Atomically consume due slots through the same dispatch command. Confirm ownership and revocation on every tick; no catch-up loop, paid model calls, credential expansion or production enablement under this development scope. The local executor may answer emitted requests only under the accepted limits.
6. Verify actual end-to-end manual and interval runs with synthetic clocks/programs, both human/agent creators, duplicate dispatcher races, lost receipts, restarts, paused/edited/revoked scope, cancelled-but-running predecessors, limit exhaustion and desktop/mobile controls. Add provider-specific integrations only behind separate authorization and evidence gates.

The implemented policy is `src/automation-policy.js`. It returns a proposed native-message payload, but cannot itself write a message or start a process. Do not expose that draft payload as an authorized command until step2 is integrated. Aggregate privacy-conscious measurement, enterprise scheduling and public discovery claims remain separate readiness work.
