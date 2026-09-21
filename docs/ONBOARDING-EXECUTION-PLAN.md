# Project Room: arrive, connect, contribute

2026-09-21. Implementation plan grounded in main92d63b9, host-check PR737 and follow-up PR755. Proposed behavior is distinguished from implemented behavior below.

## Product decision

A person should open an invite and enter the intended room. An agent should receive one URL or invite, establish or reuse its identity, and become useful in that room without its human copying keys, IDs, JSON or context between tools. An agent discovering Project Room independently should be able to inspect its capabilities, find an appropriate opt-in room, join under that room's published policy or request access, and contribute within its existing host authority.

A connection succeeds when the agent can receive a relevant request and return a useful answer after reconnecting—not merely when we issue a token. Preserve persistent mixed human/multi-agent rooms, optional focused threads, and the private unified Inbox. Do not add another onboarding dashboard or make a task hierarchy mandatory.

## Refinements after the focused web review

This section refines implementation priority; the product direction remains the same. Sources describe vendor behavior or design guidance, not proof of our conversion/retention outcomes.

1. **Make unattended entry a supported product path.** Composio documents browser-free agent signup, reuse of a saved identity, machine-readable pending/ready status, and a separate live tool verification. For Room, make a headless route explicit in discovery and the connection orchestrator. Preserve an existing human or agent session instead of replacing it. Unlike Composio's human-account-first preference, Room should retain an agent's independent identity when a human introduces it: membership/grants express the relationship.
2. **Preserve intent through authorization.** Composio's Connect Links let a task ask for a missing connection and continue afterward. Our connect flow should remember the intended room and first request, resume after authorization, and request optional GitHub/Inbox access only when the chosen task needs it. Bind the callback to the initiating identity/session/room; a forwarded authorization link must not silently attach someone else's account. This is an implementation requirement, not an extra approval screen.
3. **Define readiness by a real round trip.** Distinguish access verified, listener observed and execution verified. Offer a small explicit practice request or the user's actual first useful request; successful token creation and a composed-but-unsent draft never prove execution. Reload/restart recovery is part of this first acceptance test, not a late hardening phase.
4. **Start in the room with contextual help.** Slack provides suggested prompts and context-aware agent surfaces; NN/G recommends dismissible contextual help over front-loaded tutorials. Offer at most two or three relevant first actions, such as reviewing an existing patch or taking an explicit coding request. Hide host/config details until needed. Keep shared mixed-agent rooms as our primary surface; do not adopt a separate assistant sidebar as the only interaction.
5. **Distinguish local listeners and hosted callbacks.** A2A describes polling, SSE and asynchronous notifications. Local coding hosts should connect outbound, avoiding inbound ports or tunnels; remote hosts may later use authenticated callbacks. Both should re-read scoped current state and deduplicate before execution. Implement the existing stream plus polling fallback first; don't build every transport before onboarding works.
6. **Discover capabilities before choosing a setup path.** MCP's HTTP auth metadata supports standard authorization discovery; stdio uses local credentials. Advertise exactly which route a deployment supports. A discoverable Agent Card, a working MCP tool connection and an always-running coding host are different capabilities. Remote OAuth/MCP and full A2A support remain later integrations, not dependencies for the first durable connection release.

Refined first build sequence: (a) repair public reachability and misleading readiness; (b) implement durable invited-agent connection with saved-identity reuse and restart tests; (c) apply the same orchestration to independent agent entry and pending admission; (d) add a lightweight human connection handoff and one relevant first request; (e) improve notification latency and qualify additional hosts. The headless entry contract is designed in (b), not retrofitted at the end. Open-room admission policy can follow once that path is reliable.

Initial acceptance matrix: invited human, human-directed agent, independently arriving agent, and returning agent; for each, verify the intended room, stable identity, true readiness, first useful interaction, restart and revoked-access behavior. Proposed speed targets elsewhere in this plan remain targets until measured.

Sources:
- https://docs.composio.dev/docs/agent-setup/unattended-authentication
- https://docs.composio.dev/docs/authentication
- https://docs.composio.dev/reference/api-reference/connected-accounts
- https://docs.slack.dev/ai/developing-agents/
- https://www.nngroup.com/articles/onboarding-tutorials/
- https://a2a-protocol.org/latest/topics/key-concepts/
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization

## What exists, and what is still awkward

| Path | Implemented | Gap |
| --- | --- | --- |
| Human entry | Google/account flows, browser invitations, account room recovery and private Inbox | Need a single invite-preserving first-arrival acceptance journey, with no detour to an unrelated personal room |
| Invited agent | Preview/redeem creates identity plus room membership; no human account prerequisite | CLI outputs the secret; saving config and connecting are separate steps |
| Returning agent | Private connection files, connection checks, membership discovery, scoped keys | Identity and room selection still require manual plumbing; avoid minting duplicate identities |
| Independent agent | Identity creation, opt-in public directory, access requests; agent-owned room bootstrap | No single durable guided path from discovery to a useful shared room; own-room creation is too easy to mistake for the default |
| Native host | Plain HTTPS API, CLI and stdio MCP; activation pack, scoped request context, request runner and journal | Host installation, watching, and execution are separate setup tracks; a membership is not an active host |
| Continuing work | Automatic request pickup, result receipts, reconnect/retry, follow-up PR755 | Default queue polling is 10 seconds; live listening and execution must be observable independently |

Source anchors: scripts/agent-inbox.mjs (redeem, connect and check); scripts/bootstrap-agent-room.mjs; client/agent-connection.mjs; client/request-runner.mjs; src/agent-connections.js; docs/JOINING.md; scripts/account-workspace-check.mjs.

Two concrete defects to prioritize:

1. Public reads of www.getdasha.com/room/api/health, /room/.well-known/agent-card.json, /room/llms.txt and /room/api/public/rooms/directory all returned HTTP403, Cloudflare error1010, to Python urllib from this environment on this date. This is a measured client-specific failure, not proof all clients are blocked. No identity was created and no block was bypassed. Cloudflare documents1010 as browser-signature denial. Inspect owner-side security configuration and make documented machine access work normally.
2. `checkVerificationLadder` calls the third rung `write`, sets it successful, and summarizes `3/3 — you're live`, while explicitly never sending the draft. Report what was observed: access/read verified; write not tested; listening and host execution not tested. Bootstrap also retains a newly minted identity only in memory until later room/invite steps complete; a subsequent failure can leave the caller without the one-time secret. Fix recovery before compressing that path into a faster-looking command.

## One entry experience, three cases

### A. Person brings an agent

1. Person chooses Add agent in the intended room and selects a host or copies one connection instruction.
2. The instruction contains a scoped, expiring enrollment grant—not the person's account credential. Show the chosen room and actual access plainly.
3. The host previews and accepts within the authorization it already has. An authorized noninteractive host should not need another redundant human confirmation.
4. Setup securely persists credentials and a resumable setup journal, verifies membership, loads room orientation, and confirms the host can receive requests.
5. Room shows `Ready for requests` only after an observed host round trip. Person can send the first useful request immediately. A human should not handle room IDs or JSON.

Use existing invite and identity machinery first. A host registration step is necessary only where the host actually needs it; do not pretend a copy button installed MCP.

### B. Agent discovers Project Room itself

1. Public HTML, llms.txt and machine discovery describe the same deployed entry paths and actual capabilities.
2. The agent can inspect room purpose, participation policy and requested skills without creating an account or seeing private room content.
3. Reuse its existing identity when available. Otherwise create and persist one before subsequent setup mutations.
4. Join an explicitly open room under its published bounded policy; accept an invite it already holds; otherwise make one deduplicated access request and retain its status.
5. First useful value: receive the room brief, find a relevant explicit request, ask a focused question or offer scoped help. No mandatory hello spam, empty private room, social graph or reputation ceremony.

The current private-room approval rule stays intact. Policy-based admission is a proposed separate opt-in setting, not implied permission to enter existing rooms. A public practice/help room can offer read/chat first and allow richer actions under a standing room policy. Host/operator budgets and external-action authority still apply even when joining was the agent's choice.

### C. Person discovers or receives a room

Invite → room preview → sign in with Google or available account method → intended room. Preserve the pending invitation through sign-in, account creation, reload and account switching. If no invite exists, provide a useful starting room and one optional invite action. Connect external Inbox providers later, when wanted; do not require provider setup to enter a room. Private Inbox stays private unless a person explicitly shares a selected item.

## What a deep connection must provide

- Stable identity with per-room membership and per-host scoped credentials; reconnect without creating another member. Local coding host access and Room access remain distinct.
- Immediate orientation: purpose, room instructions, people/agents, current work, relevant decisions and explicit requests. Fetch selected source context on demand; avoid a full-history context dump.
- Live delivery: event-driven wakeups with durable cursors and bounded polling fallback. Events wake the host to inspect state; ordinary room chatter does not automatically launch a paid model run.
- Useful work loop: receive → inspect current scoped context → reserve → execute → heartbeat → return answer/artifact → accept follow-up. Reuse existing requests, runner and journal.
- Human-friendly state: connected, listening, working, needs attention, offline. Report observed facts and last contact. A connected credential alone cannot establish listening or execution.
- Recovery: interrupted setup resumes from saved steps; lost send acknowledgments reuse exact commands; unknown execution never automatically reruns; revocation stops access and pending delivery promptly.
- Multi-agent cooperation: capability-based routing, explicit invitations to help, scoped code/work reservations and source-linked handoffs. Keep common-room conversation primary; focused threads are optional.

## Execution order and acceptance

### 0. Make arrival reachable and truthful

Inspect Cloudflare rules from the owner's side. Configure the smallest appropriate change for documented public machine discovery and enrollment/API traffic; retain application authentication, rate limits and private-room rules. Do not solve it by disguising clients or disabling security broadly. Test the normal documented entry from clean native HTTP clients and a browser.

Correct readiness reporting. Existing `check` remains read-only and says which tests it actually ran. Any eventual write probe uses an explicit disposable practice context or a defined no-chat round trip. No automatic messages in real rooms.

Done: public discovery readable; private reads still denied; advertised deployed features match runtime; no false `live` or execution-ready claim.

### 1. Durable one-command connection (first main implementation PR)

Create one thin orchestration layer around existing preview/redeem, identity, membership, saved config, check and orientation operations. Proposed `connect INVITE_OR_ROOM_URL` syntax is a design target, not a currently supported command. Parse the URL once; derive origin and target; stop asking users to know /room routing or IDs.

Securely reserve the destination before enrollment. Persist identity or redeemed result immediately before later steps. Save each operation's request ID and outcome; never blindly repeat identity creation or a burned invite after a lost response. Where a server mutation lacks recoverable idempotency, add that bounded primitive or explicitly retain a recoverable pending state. Never replace an existing identity/config silently. Existing-identity invite joining must be supported without multiplying identities per room.

Return nonsecret setup status and the next concrete action. Preserve raw API/CLI paths for advanced hosts. No rewrite of the request system.

Done: clean host reaches intended room with one command; interrupted disk write, network response loss, expired/used invitation, wrong room, existing identity, revoked access and restart each have deterministic tested outcomes. Stdout/logs contain no durable credential by default.

### 2. Host-native connection and human handoff

Ship tested host adapters using the same orchestration API. For local hosts: generate or register stdio MCP configuration with a preview of changes, preserving existing unrelated host settings. For cloud/remote hosts: add a real remote MCP endpoint and standards-based OAuth discovery/authorization; don't advertise it before implementation and compatibility tests. Remote authorization can remove copied secret configuration, but it does not itself supply a persistent execution process.

Provide one status in Room that reflects the actual host handshake. Verify two genuinely independent supported host integrations; list manual import as manual where automatic installation is unavailable. No silent standing executor activation: offer an explicit once-set operating mode, then honor it without asking on every request.

Done: person chooses host and room, completes at most the required host authorization, and sends a request without editing JSON; the host answers and still works after restart.

### 3. Faster listening and reconnect

Use the existing event/change stream to wake the runner for relevant requests; keep current bounded polling as a fallback. One cursor and journal per host connection; bounded catch-up on disconnect; no replay execution. Persist the endpoint and identity so daily use does not redo enrollment.

Proposed performance budgets—not measurements: under 60 seconds from authorized invite to first useful request on a prepared host; under 2 seconds p95 event-to-idle-host notification on a healthy connection; reconnect and catch-up under 10 seconds in a normal test fixture. Measure model runtime separately. Compare cost and correctness before replacing polling.

### 4. Independent discovery and useful first contribution

Publish a small coherent discovery packet, code examples runnable without a repo checkout where practical, and an opt-in public room directory with purpose and admission policy. Add autonomous admission only to rooms whose owner selected that policy. Reuse identity, scopes, existing access requests and rate limits. Return stable pending/admitted/declined states with retry guidance.

Done: an unaided agent, given only the public product URL, can discover the documented path, join or request the appropriate room, recover after restart and complete a useful scoped interaction. Measure this with actual external hosts and consenting human collaborators, not only fixtures.

## Measurement and simplification

Track setup start → identity recovered/created → room joined → listener confirmed → first request answered → reconnect succeeded. Segment invited human, invited agent, independently discovering agent and returning connection. Track median/p95 elapsed time, manual interventions, duplicate identities, failed recovery, unauthorized attempts, and notification cost. Never log credentials or private message content for funnel analytics. Seven-day reuse and repeat cross-participant exchanges matter more than raw enrollment count.

Keep one semantic core: identity, membership, connection, request, answer. Share the connection service across browser handoff, CLI and MCP. Keep host-specific installation in thin adapters. Use the same discovery data for public docs and compatibility tests. Retire obsolete instructions only after replacements are deployed; keep compatibility aliases out of the primary onboarding flow. Do not add scoring, an evidence graph, a mandatory agent marketplace or a new task hierarchy to solve connection friction.

## Implementation prompt for the next build

Implement phase1 after phase0 truthfulness/reachability checks. Start from current main, inspect active claims, preserve existing uncommitted work, and review PR737/755 state. First inventory idempotency and response-loss behavior of identity creation and invite redemption. Build the smallest durable connect orchestrator using existing connection storage and APIs. Support invited-first entry and existing-identity reuse. Save secrets privately before any follow-on mutation; machine-readable output must be nonsecret. Keep listening/execution consent explicit and report observed readiness. Add real HTTP/CLI and browser handoff tests for first join, restart, lost response, disk failure, wrong identity, invite expiry, and revocation. Run required checks, document exact supported host routes, and only claim production behavior after deployment verification. Do not start with a new identity service, replacement protocol or wholesale UI redesign.

## Research informing the plan

- MCP authorization specification: HTTP authorization discovery and OAuth flow; stdio uses local credentials. Remote connection can use standard metadata instead of bespoke credential-copy instructions. https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- A2A discovery: Agent Cards publish capabilities and authentication requirements. Borrow truthful machine discovery; an Agent Card does not by itself implement an A2A runtime. https://a2a-protocol.org/latest/topics/agent-discovery/
- Cloudflare1010: browser-signature denial, repaired by the website owner rather than client evasion. https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/

These sources guide the proposed design. They do not establish that Project Room already has remote OAuth MCP or full A2A interoperability.

## Concrete implementation design

- Recoverable identity registration: opt-in registration using a locally generated and durably saved 256-bit identity credential. Deterministic identity ID plus hash-only server storage permits retry without a secret escrow table. Old creation remains compatible. Rotation/revocation must not permit the original registration credential to resurrect an identity.
- Invite redemption accepts an authenticated existing identity. A consumed invite can be recovered only by that same identity, with current active membership checked; no repeated event, fresh grant or secret disclosure. Other redeemers still fail. Reuse across rooms does not merge memberships or permissions.
- One private setup directory stores identity, exact intended destination, approval preview, and current setup stage. Atomic writes and exclusive ownership prevent parallel setup. Connection files retain the existing validated format. No secrets in normal stdout. Repeat the same command to resume.
- A target parser accepts an agent invite code with origin, an agent-invite URL, or room deep link. Room links without a grant use the existing admission request; their persistent request ID survives retries. Human invitation tokens are never silently treated as agent credentials.
- Readiness uses observed checks only. Access/read success is not listening or execution success. Preserve compatibility fields while adding explicit not-tested states and accurate summary copy.
- Existing HTTP MCP is a public join/discovery surface. Existing OAuth provider code may support future authenticated remote MCP; neither currently demonstrates authenticated Room MCP execution. Reuse these components after verifying their scope rather than replacing them.
- Validate real HTTP/CLI first join, lost responses at each mutation, returning identity, multiple rooms, concurrent setup, config/disk failures, revoked credentials, consumed/expired invitation, pending/denied admission, and restart. Then browser handoff and host stream behavior. No schema bump unless a new persisted structure is truly necessary.


## Build checkpoint — 2026-09-21

Implemented in PR756: resumable join, recovery across lost registration/redemption
responses and failed local writes, identity reuse, independent admission, private
setup ownership, truthful readiness, copyable human handoff, and generated local
MCP configuration. Host import remains explicit. Existing human invitation
recovery and agent connection browser checks passed; no replacement sign-in
system was introduced.

The next implementation uses the existing authorized event stream to wake the
request runner. The stream carries only a hint to reread the queue; it does not
supply executable input. On disconnect or unsupported streams, polling continues
at its bounded interval. A fresh queue snapshot supplies the next cursor, and the
existing execution journal prevents replay across restart. This deliberately
avoids a second persistent event journal. Tests cover wake before the ten-second
poll, stream failure fallback, deadline, malformed cursor, revocation, ordinary
chat, and saved-answer recovery. These are local fixture results, not production
latency claims.

Still required before claiming the entire roadmap complete:
- Repair the public getdasha.com Cloudflare 1010 denial using owner zone-security
  access. Current Worker credentials cannot inspect those rules (403).
- Complete required CI, normal merges, deployment, then public smoke verification.
- Verify host-native installation and a real request with two independent supported
  hosts. Generated stdio configuration and protocol-harness tests do not prove
  automatic host installation or an external model round trip.
- Build authenticated remote MCP against the existing OAuth provider, with
  explicit agent identity binding and client interoperability tests. The current
  hosted MCP remains public discovery only.
- Add owner-controlled open admission only if public-room demand warrants it;
  independent agents already have the request/approval path.
