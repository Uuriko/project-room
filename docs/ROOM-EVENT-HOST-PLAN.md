# Room event host: implementation and design plan

Status: implementation plan, 22 October 2026. This document distinguishes existing mechanisms from new work and release gates. No Codex scheduled automation is part of this design.

## Outcome

A person or authorized peer sends a request in a room. The receiving Mac notices it without a human forwarding text, delivers its pointer to the selected agent session, and preserves enough evidence to distinguish queued input, actual execution, a saved reply, and acknowledged handling. Network changes, app restarts, duplicate notifications and uncertain delivery must not silently duplicate work.

The product experience is one room and one conversation. Devices contribute capabilities; users do not manage transports, polling scripts, or a second task board. The first implementation connects existing Room events to an existing explicitly selected Codex session using the supported `codex queue` command. A separate shared-assistant host already exists and has a peer-owned event-wake change in PR4553. These are two adapters for different conversation surfaces, not competing schedulers.

## Existing components and ownership

## One human prompt, two agents

The target interface is the existing Muse composer. In an owner-enabled assisted conversation, sending a work request creates one shared run tied to the original message. Both selected agents receive durable delivery records for that same run. They do not receive two independent instructions to implement the whole task. Ordinary conversation stays conversation; the composer should clearly indicate when the connected team is being asked to work, using the existing assistant interaction rather than another invite or setup flow.

Each Mac has its own device identity and each agent has its own member identity even when both Macs use the same human account. A shared login must never collapse delivery acknowledgements or work ownership. Display receipt states separately: waiting for Mac, delivered, working, needs input, completed. Online presence alone does not prove receipt or execution. Simultaneous delivery means independent prompt notification as soon as each host is available, not guaranteed synchronized execution.

Use the existing shared-assistant run as the root. One fenced coordinator assigns scoped child work; peers claim non-overlapping work and record outputs against that root. The initial two-Mac default is implementer plus independent reviewer, with parallel implementation only for disjoint scopes. Both can read the prompt and propose changes, but only the current coordinator integrates the final result. Lease expiry permits recovery; fencing prevents a stale coordinator from publishing a second authoritative completion. Reuse existing claims and attempts rather than creating a second task system.

Progress, questions, evidence and the final response belong in the original Room thread. Preserve attributed agent replies while showing one compact team status. Human follow-ups revise the shared scope; cancellation stops new dispatches and requests cancellation of existing attempts. Agent status messages must not automatically create new runs or recursive replies.

Execution belongs in a persistent Room Host on each Mac. The supported Codex queue adapter is an interim integration with an existing session; the shared-assistant runtime is the path to Room-owned sessions whose transcripts and lifecycle are managed from Room. Neither approach makes this particular chat's private history automatically available in Room: seed an explicit project brief, decisions and links to artifacts.

Acceptance: one human message creates exactly one root run and two recipient records; two connected hosts receive it; claims prevent overlapping writes; one host can disconnect and later catch up; duplicate delivery and restart do not repeat completed work; follow-up and cancellation reach both; outputs appear in the source thread. Verify all of this with two real Macs before advertising the end-to-end flow as ready.

Current boundary: the new queue service handles authorized directed messages. It does not yet implement public human-message fan-out, shared assignment, or the unified composer experience. Coordinate that extension with the peer-owned shared-assistant change before editing its files.

## Existing components and ownership (implementation)

- `AgentWakeClient` owns server listener registration, fenced ownership, bounded wake pages and acknowledgements.
- `room-listen.mjs` establishes a receiving loop and retries transient errors but does not execute models.
- `queueRoomPointer` persists intent before invoking Codex, binds the room/member/thread, rejects changed pointers and retains uncertain transport outcomes across restarts. It does not infer execution or acknowledge Room notifications.
- `completeReplyWake` verifies a DM/mention reply before acknowledging that signal. Formal requests have their own revision and response semantics.
- `request-runner.mjs` and the Codex runtime preserve execution attempts/results. The new local timeline in PR4555 adds diagnostics; this service need not duplicate it.
- The other Mac owns shared-assistant supervisor/event-wait changes. Do not edit those paths while implementing this adapter.

## Phase 1: persistent delivery service

Add a service library and CLI, with injected dependencies for deterministic fault testing. The operator supplies one private configuration containing the exact Room connection directory, Codex executable, target thread UUID, stable host ID, private journal directory and permitted sender IDs. Read credentials only through the existing connection loader; never copy them into the status file or command arguments.

Acquire one local service ownership lock before connecting. Use the existing server listener lease to prevent competing machines from consuming the same identity's queue. A contended listener waits; it must not take over another live listener or produce a model wake through an alternative path.

Perform a bounded initial wake read, then server-held waits. Handle pagination so a large backlog cannot hide newer work behind the first page. Bound pages per cycle and new dispatches per cycle. Renew/revalidate the listener immediately before a new queue operation; a changed pointer or lost lease must prevent dispatch. Existing accepted/unknown receipt records must never cause a second dispatch on restart.

Accept only supported message-bearing wake types in the pinned room. Fetch the source message and verify author and recipient against the operator policy. A room membership or someone else's text is not authorization to launch arbitrary work. The forwarded input contains identifiers and fixed guidance, not an executable command supplied by the sender. The agent fetches current context and acts within the existing user authority.

Write a compact atomic private status document: connecting, listening, contended, retrying, queued, attention-required or stopped; include checked time, signal ID and transport outcome where relevant. Never label queued input as running. Status readers must check freshness. Keep ordinary loop output quiet; no periodic chat turns or acknowledgement chatter.

## Phase 2: supervised installation on the Mac

Qualify the exact installed Codex command with `queue --help` and pin its absolute executable. Install immutable tested source/runtime files in a private directory and a launchd job with explicit arguments, paths and a private working directory. Do not depend on an interactive shell's PATH. Launchd owns process restart; Room owns work delivery. User pause/removal must stop restart behavior.

Transient network/service errors retry within the process with backoff. Authentication refusal, incompatible state or malformed configuration stops with a repairable diagnosis rather than a rapid restart loop. An unexpected process crash may restart; durable queue receipts prevent duplicate dispatch. Use separate state directories for devices and adapters. A configuration change must not reuse receipts under a different implicit identity.

Keep the existing network diagnostic watcher separate during qualification. It helps distinguish hosted Room outage, tunnel failure and unavailable SSH worker, but does not dispatch tasks or certify delivery. Consolidate its visible status into My Mac later; do not create a second public connection screen.

## Phase 3: verify an actual conversation

Ask the peer to send a fresh bounded coordination question with an unmistakable request ID. Measure server event time, local receipt, queue acceptance, agent response and verified Room response status separately. A successful queue subprocess is only transport acceptance. A busy chat can defer the next turn; report that limitation honestly rather than promising instant replies.

Respond in the same private/public conversation. Formal requests must be read in full, answered against their current revision and verified afterward. Ordinary notifications may be acknowledged only when a stored matching reply or an explicit handled decision provides evidence. A no-action message should not generate a reflexive reply; prevent acknowledgement loops and cap unsolicited chatter.

Do not manufacture fresh work by retrying an old uncertain operation. On an ambiguous queue result, retain the journal and show attention-required until the existing session or reply history establishes what happened. Future reconciliation improvements can use supported session evidence, not guessed success.

## Phase 4: reconnect and interruption experiments

Before switching Wi-Fi, collect a baseline showing Room access, listener ownership and peer availability. Switch one Mac first while the other retains internet, then the second. Leave both awake and complete captive portals. Verify pending requests survive and the service resumes without manual launch. This is a real experiment and cannot be claimed passed before the networks change.

Fault tests must include: transient 503; DNS/transport timeout; lost queue response; duplicate event; crash after persisted intent; crash after accepted queue; competing listener; revoked credential; deleted source; wrong room/sender; backlog pagination; stop during a wait; app not available; sleep/wake; and result delivered with lost acknowledgement. Inject failures in isolated tests before disruptive live experiments. Do not interrupt the only network path just to demonstrate a fallback.

Tailscale direct/relay selection is transport infrastructure. Room messaging uses outbound HTTPS and must not depend on peer SSH. A sleeping laptop is unavailable, not broken. A second laptop on the same hotspot does not provide a second internet uplink. Do not advertise automatic wake or independent backup without a separate verified mechanism.

## Phase 5: cohesive desktop experience

Extend the existing My Mac surface after the runtime is qualified. Primary control: 'Let this Mac help this room'. Show connected identity, selected agent session, current work and a Pause control. Detailed limits and sender/capability policy belong behind an expandable settings view. Do not add a competing inbox, scheduler dashboard, or mandatory setup form.

Statuses describe observed facts: Listening; Waiting for agent; Working; Reply waiting to send; Needs sign-in; Offline. Show last contact when stale. Distinguish pause from sleep and server outage from local network trouble. Preserve one unified notification destination: meaningful requests for input, failures requiring action, and useful completion. Suppress unchanged retry noise.

The joining wizard should detect existing setup, reuse identities and explain which resources are actually enabled. Joining a room does not silently enable screen control or unrestricted execution. Previously authorized capabilities can reconnect without repeated permission prompts. New capabilities remain explicit and reversible.

## Phase 6: execution and resource expansion

Use task-specific adapters with a common readiness/start/reconcile/cancel/result contract. The Codex desktop-session queue adapter and dedicated app-server host must expose their different capabilities. Do not promise that a queued desktop message is a running autonomous worker.

Allow concurrency for independent tasks, constrained by measured CPU/RAM, resource budgets and workspace ownership. Serialize only shared mutable resources such as a checkout or interactive screen. Use isolated worktrees for coding. Never permit two agents to control the same visible desktop without an explicit handoff. Worker availability and owner pause win over a remote request.

Begin with useful low-risk tasks: independent tests, preview verification and artifact reuse. Compare matched one-Mac/two-Mac workloads and include transfer, review and recovery time. Add broader resource sharing only after the loop reliably returns accepted results. Do not build a marketplace, custom VPN or distributed database to solve the immediate message-delivery gap.

## Acceptance and release

Focused tests cover the state machine and actual local subprocess failure behavior. Integration tests use a real local Room server where needed; mocks must not substitute for persistence or authorization contracts. Run repository affected tests, lint, full suite and required room benchmark before push. Keep inconclusive performance results. Submit a focused PR and attach exact tested head. Follow current room claims and release holds; green local tests are not deployment evidence.

Local installation may be qualified independently of a server release because the service uses existing endpoints. Report source built, tests passed, local service installed, event queued, agent replied, merged and deployed as separate facts. Mirror on the second Mac only after the first flow is verified and its existing listener ownership is reconciled.

Initial target: prompt dispatch on an awake idle connected host, ideally under two seconds after local receipt. Measure actual end-to-end distributions before setting an SLA. Hard correctness requirements: no blind redispatch after an uncertain side effect; no authority expansion; no acknowledgement merely because input was queued; no lost pending work on process restart.

## Rollback

Unload only the new launchd service and preserve its journal. Leave Room requests pending and retain all uncertain receipts. Revert the local config/runtime pointer to its previous version without deleting execution history. The existing manual Room tools remain usable. Do not reset keys, remove another listener, kill the desktop app or replay pending work as a shortcut.

## Open work after the first slice

Formal-request ACK reconciliation, native desktop integration, cross-provider adapters, independent offsite backup and true offline collaboration require additional verification. Keep them visible as unfinished, not implied by a working transport. The first release earns expansion by removing the need for John to forward one real peer request and by surviving an interruption.

## Qualification checkpoint (22 October)

Actual startup exposed a timeout before the delivery loop reached its queue.
Delivery-only AgentWakeClient.wait now omits broad resume projections but retains
fresh checkConnection before/after polling, listener acquisition/renewal and token
fencing. The default wait still gathers full observations. This option is for
pointer transport only: it never authorizes execution from a message alone.

Regression testing found page starvation across bounded batches. The service now
retains its cursor between batches and replays partial pages through durable
receipt deduplication. Expired fetch signals are checked before creating a promise
so an already-expired resume request cannot leave an orphan rejection.

Local qualification uses an immutable runtime based on identity-preflight commit
fb2add3a4adcf30b2c05eb9591e463d071bb9bc5 plus the three new/changed service modules.
It is not a production release or a clean single-commit build. The launchd service
starts after login and restarts signal crashes; transient network errors retry in
process. Permanent failures exit and need repair. Full reboot and actual queued
reply remain acceptance gates, not claims established by installation.
