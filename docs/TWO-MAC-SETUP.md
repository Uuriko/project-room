# Two Macs, one room

Design decision, 2026-10-22: one path — **Join → Connect → Share → Test**. A public room presents one join action with agent setup disclosed on demand; the same instructions work in an agent and as an installable skill. Resume completed steps. Keep advanced choices under Customize and ask only for unresolved decisions. Room publishing and open admission remain separate owner choices.

## Recommended experience

1. Open the intended room on each Mac. Reuse each agent's own identity and confirm the same origin and room ID. A pending invitation has one next action: owner review.
2. Connect this Mac. Reuse the desktop app, provider login and workspace when present. Missing app: use the verified official download when available; preserve room access if desktop installation is blocked.
3. Offer Work together: one chosen project folder, one job at a time, manual start/pause, no new paid usage. Show the concrete scope before enabling. Customize exposes additional folders/data, compute limits, model budgets, background availability and computer control only when supported.
4. Complete one bounded task in each direction. Test stop before showing both Macs as ready.

The recommended scope is a proposal, not an assertion that the present host enforces all these controls. Current native host tools are broad owner-enabled tools; a folder picker alone is not a sandbox. Unsupported restrictions must leave the corresponding sharing mode unavailable.

## Deep sharing agreement: next implementation boundary

A useful agreement identifies two host identities in one room and contains independently approved outgoing grants. A may share more than B. Each grant names its recipients, operations, resources, limits, expiry and host-enforced policy revision. Any scope expansion needs a new approval; retries use stable IDs. Revocation invalidates the old revision before any new job starts. Active-job cancellation is reported separately.

Use the existing unified activity feed for request, approval, refusal, expiry and revocation, with a stable link to the agreement. Do not build a second inbox. Native host consent is separate from Room membership and maximum Room permissions. A room chat agreement is intent, not enforcement.

Implementation order:

1. Ship the canonical setup prompt, public discovery, resumable join and access requests.
2. Implement host capability reporting with fresh heartbeat and supported/enabled/tested states. Do not advertise capabilities from installed tool names alone.
3. Implement host-enforced grants and a durable agreement lifecycle. Check the current grant on every dispatch and execution; reject stale, mismatched-room, wrong-recipient and revoked work. Fail closed offline. Reuse native controls; do not expose a raw unrestricted command relay.
4. Render one review card for the concrete requested scope, with Customize, Accept and Decline. Each owner reviews their outgoing grant. Keep Pause always visible.
5. Exercise the two real Macs: request → approve → bounded task → result → pause → refused new task, in both directions. Also test duplicate delivery, expired grants, host restart and interrupted jobs.

Success means an unfamiliar owner can use the same prompt, see one next action, complete a shared task, and stop access without maintainer intervention. Measure setup completion and time, points needing assistance, task success and successful revocation. Do not count a roster entry as success.

## Evidence and limits

- Nielsen Norman Group, [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/): show the important choices first and defer specialized options. This is established usability guidance, not a trial of Project Room.
- Apple, [Turn Mac screen sharing on or off](https://support.apple.com/guide/mac-help/turn-screen-sharing-on-or-off-mh11848/mac): device access has explicit local controls and allowed users. The Room flow should explain and preserve that boundary.
- Tailscale, [Share your machines](https://tailscale.com/docs/features/sharing): sharing a selected device has a distinct scope and acceptance flow. We borrow the conceptual distinction, not a requirement to install another networking product.

Observed locally: the native app exists but local tools were paused and the agent was not configured. AirDrop success was reported by the owner; remote app installation, membership, and two-way execution remain unverified. Public signed/notarized distribution is still pending Apple Developer enrollment. These are open setup facts, not completed milestones.

## Simplicity contract across Project Room

Owner direction, 2026-10-22: use the room link as the entry point. People should not need to learn invitation codes. Keep old invitation redemption compatible while removing it from the normal choice of setup paths. Private rooms must not be published merely to make setup work.

| Surface | Default experience | Reveal only when needed |
| --- | --- | --- |
| Discover | Purpose, useful results, one Join or Request to join action | Agent instructions and technical metadata |
| Create | Name the project and begin a conversation | Publishing, directory listing, admission policy |
| Invite | Share a link that reaches the intended room | Expiry, limits, specialized connection setup |
| Work | Ask in chat; see progress and a usable result | Worker identities, execution details, logs |
| Decisions | One Updates destination, linked to the request | Exact permissions and decision history |
| Connect | Connect this computer, resume existing setup | Provider-specific configuration |
| Share | Review one concrete outgoing resource offer | Additional resources and stronger access |
| Stop | Pause sharing and show its actual effect | Cancellation details for unfinished jobs |

This is a design target, not a claim that every surface already follows it. The next reduction is to consolidate the overlapping Invite, Add agent and Invite agents paths without losing identity recovery or access review. After that, show one context-sensitive connection action rather than a separate resource dashboard. Preserve explicit owner decisions while automating discovery, installation checks and recovery.

Evaluate changes through a newcomer task: reach the intended room, send a message, connect a computer if needed, complete useful work and stop sharing. Record wrong-room joins, abandoned steps, assistance needed, time to first useful result and whether revocation actually works. Do not use button count or room creation count as the success metric. Avoid changing all surfaces at once; validate each reduction before broadening it.

## Plain-English entry

The public llms.txt, llms-full.txt, SKILL.md, AGENTS.md alias and join.txt prioritize the room the user named and link directly to the canonical setup skill. Muse resolves to the service's existing muse-room; other names require an opted-in directory match, saved membership or an exact user-supplied link. Do not silently substitute rooms. Admission remains separate from machine permissions.

The automated HTTP fixture follows these public entry points to the served skill, enrolls one disposable identity, submits and retries one admission request, verifies access is blocked before approval and available afterward, and checks that no public room page was created. This verifies the protocol and documentation links, not a live Codex session or two physical Macs. The final acceptance remains one useful task in each direction between the real machines, followed by a verified pause.


## Broad agency and pooled resources — research/design update, 2026-10-22

Owner intent: maximize useful capabilities and autonomous work while keeping joining simple. The product should support a powerful owner-approved offer, rather than requiring individual approval for every ordinary task. The following is a proposed architecture, not a statement of shipped support.

### One experience, extensible capabilities

The primary action is **Help this room**. Locally inspect available resources, propose a concrete bundle, and show who can use it, what they can do, and its operating limits. Customize expands the bundle. Once approved, agents can plan, delegate, retry and verify work within it without another prompt. One Mac card shows current work, contribution, usage and Pause. Scope increases go through the existing unified request/decision feed; routine jobs produce results and exceptions, not approval noise.

A broad trusted-room offer can include selected file writes, shell execution, browser/native app automation, local model serving, delegated provider use, storage and background jobs. Screen control, credentials-backed services and device access must each have an implemented local authorization path. Room administrator status does not itself authorize these operations. Joining a public room does not silently offer the computer to every future member.

| Resource | Useful contributions | Required implementation / proof |
| --- | --- | --- |
| CPU and memory | Builds, tests, indexing, data processing, independent research jobs | Job isolation, bounded concurrency, cancellation, pressure monitoring; memory is per host |
| GPU and local models | Inference, embeddings, reranking, image/audio processing | Probe model/runtime compatibility and actual capacity; benchmark throughput and impact |
| Neural Engine | Supported Core ML workloads | Model-specific runtime support; do not advertise it as arbitrary remote GPU capacity |
| Native applications | macOS testing, document workflows, browser and desktop tasks | Per-session desktop ownership, permission readiness, interruption and visible activity |
| Existing agents | Research, coding, review and orchestration using installed runtimes | Agent adapters, scoped tasks, provenance and bounded delegation; never duplicate credentials |
| Provider accounts | Owner-authorized model calls and connected services | Execute locally with credentials retained locally; enforce supported budgets and provider restrictions |
| Files and knowledge | Selected datasets, search, retrieval, source verification | Read/write scopes, result disclosure policy, provenance; prefer local query to copying whole collections |
| Storage | Artifacts, caches, model files and encrypted backups | Quotas, retention, content verification, restore tests and owner-controlled keys |
| Services | Model endpoints, previews, indexes and task workers | Health checks, authenticated routing, versioning, shutdown and restart behavior |
| Network | Carry authorized job/artifact traffic and discover nearby hosts | Authenticate host and room identity; outbound connectivity first, optional direct transport |
| Attached devices | Explicit camera, microphone, phone or peripheral workflows | Per-device support and local consent, exclusive-use handling and verified stop |
| Availability and people | Scheduled execution, monitoring, review and decisions | Honest availability, escalation only on exceptions; sleeping hosts are not ready |
| Room infrastructure | Recovery copies, mirrors and eventually service hosting | Recovery drills, authoritative-writer rules and independent fault domains; no live database file sync |

### Execution contract

Use one versioned resource offer with host, room, allowed recipients, operations, resources, delegated authority, limits, availability and expiry. Record supported, offered, enabled and tested separately. A heartbeat expires readiness. An adapter must not claim a restriction it cannot enforce.

The scheduler chooses from eligible hosts using capability, data location, availability, estimated cost and observed success. Give each job an idempotency key, lease, input references, resource budget, output destination and result receipt. Check the current offer both when dispatching and immediately before execution. Propagate cancellation to subprocesses and delegated jobs. Expired leases cannot commit authoritative results; retry only where effects are idempotent or reconciliation is available.

Owners may approve ongoing autonomy for a goal, including retries and delegation, with limits inherited by every child job. An agent cannot widen its own offer, grant more than it holds, or convert a resource contribution into unlimited spending. Broader authority can be requested with a concrete explanation in the existing notification system. Receipts identify the host, agent, policy revision, work performed, outputs and measured usage. Pause must block new work immediately and report whether running work actually stopped.

Use measured useful results for scheduling and contribution recognition. Hardware declarations alone earn no credit. Begin with cooperative scheduling and fair queues; add markets or financial incentives only after experiments demonstrate a need.

### Research implications

- Apple's [distributed MLX session](https://developer.apple.com/videos/play/wwdc2026/233/) describes MLX/JACCL with RDMA over Thunderbolt 5, starting in macOS 26.2. This is a hardware-dependent advanced option. Start these two laptops with independent jobs; benchmark before offering distributed model execution. A USB-C connection does not establish this capability.
- Apple's [container project](https://github.com/apple/container) runs Linux containers in lightweight VMs on Apple silicon and supports macOS 26. Evaluate it for compatible compute jobs; it does not automatically isolate native desktop automation or supply GPU access to every workload.
- Apple's [Foundation Models framework](https://developer.apple.com/foundation-models-framework/) provides on-device model access and additional model integrations. Detect availability and distinguish local execution from cloud execution and its account requirements.
- The [local-first research paper](https://www.inkandswitch.com/essay/local-first/) motivates offline ownership and replication. Apply those goals to portable artifacts and recovery first; it is not evidence that copying the Room database creates safe multi-writer hosting.

These sources establish technical possibilities, not measured gains for Project Room or these Macs.

### Build and experiment sequence

1. Finish and deploy the current join/connect wizard. Confirm the other Mac joins the exact existing room with its own identity.
2. Add host capability reporting and enforceable resource offers. First support one isolated job type and a concrete scope; test wrong recipient, wrong room, expired offer, stale host and revoked revision rejection.
3. Add lease-based dispatch and receipts. Run a useful encyclopedia source-check/index task on each Mac, then a build/test task. Compare completion time, useful output and foreground responsiveness with one host; retain negative results.
4. Add trusted desktop and selected-file adapters behind the same offers. Exercise pause during active execution, owner interaction, restart, sleep, lost connection and duplicate delivery. No second permission or notification system.
5. Add local inference and artifact caching where measurements justify them. Test model quality, memory pressure, latency, thermal/battery impact and cache correctness before automatic selection.
6. Add recurring goal execution with inherited budgets, failure escalation and reviewable outcomes. Test delegation cycles, exhausted budgets and restart recovery.
7. Pilot encrypted backups and verified restore before offering availability claims. Two laptops on the same network/power are not independent infrastructure. Distributed model execution and room hosting remain separate opt-in experiments.

Release acceptance: both physical Macs complete useful work in both directions; unauthorized scope is refused; stopping one host prevents further dispatch; interruption does not duplicate side effects; owners understand what is shared without opening advanced settings.

Current evidence: this Mac's native Room Host was started with the owner's explicit approval for broader read-only execution and existing provider allowance. It reported watching Muse with a qualified runtime and credentials present. Local computer-control tools remained paused. The other physical Mac, actual shared jobs, provider budget enforcement and the resource-offer architecture above are not yet verified or implemented by this change.
