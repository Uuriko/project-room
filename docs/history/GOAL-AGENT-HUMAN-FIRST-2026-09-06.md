# Project Room: expanded human-first and agent-first goal

Requested by John on 6 September 2026. Research checked on that date (America/Los_Angeles).

## Status and how to use this document

This is the written goal addendum and consolidated reference for the next authorized continuation. The original app goal is reproduced below unchanged; the additional requirements extend it without relaxing its release gates. The app goal remains paused. The available goal controls cannot edit an existing objective, so this document does not claim that the app's goal field was changed or resumed.

This planning request authorizes this document, not implementation, live agent connections, publishing, recruitment, payments, or deployment. Do not overwrite the canonical worktree's unfinished invitation fixes. Before implementation resumes, reconcile the latest independent reviews; previous green test counts are not release approval.

## Original goal, preserved verbatim

Build Project Room into a trustworthy, chat-first home where humans and AI agents converse naturally, turn messages into accountable work, exchange exact evidence, recover after interruption, and act through bounded authority without human transcript relays. Make it as welcoming as Slack or Discord.

Continue until one canonical, production-ready candidate has reproducible evidence for John's go/no-go. Reconcile Phase 0 30eaa935, composer d511641, Agent Gateway/Quiet Focus 7ccbe2f, PR #12-#14 disposition, and missed-delivery work. Preserve validated behavior; re-author obsolete-base ideas narrowly.

Invariants: delivery, reading, completion, verification, approval, and execution are distinct. Messages, prompts, names, and claims grant no authority. Agents have disclosed owners, immutable runtime bindings, scoped context, budgets, and stop controls. Authorization intersects identity, membership, room capability, work scope, connector grant, exact version, budget, and approval. Checks bind to exact evidence; changed work inherits no PASS. Unknown outcomes stay unknown; replay never repeats side effects. Leaks, unauthorized/duplicate actions, deceptive status, and stale-worker commits block release.

Milestones:
1. Establish one canonical line with tests, provenance, risks/decisions, revisions, and rollback. Canonicalize accounts, memberships, human/agent identities, runtimes, credentials, sessions, and auth epochs; prove invitation, switching, isolation, and revocation.
2. Implement one authoritative Work Item and next-actor model preserving source conversation and distinguishing executor, producer, independent verifier, exact evidence, decision, rework, and external action. Harden chat, threads, drafts, catch-up, literal search, accessible composition, durable cursors, idempotency, and missed-delivery recovery.
3. Port the Agent Gateway with explicit wake rules, bounded context, fencing, budgets, and anti-loop tests. Connect one real runtime only after credential safety; initially make it mention-only, thread-scoped, read-only, pausable, and unable to access files/tools or write externally. Never fake presence or silently fail over.
4. Prove five GitHub handoffs from human proposal through exact executor evidence, direct review by a known distinct verifier, and human decision. Include two authenticated agents; require zero transcript relay, duplicate action, hidden producer, or acknowledgement loop. Finish permission-aware search/catch-up, calm notifications, onboarding, export, retention/deletion, and read-only GitHub ingestion.
5. Validate WCAG 2.2 AA with automated and human assistive-technology testing on physical mobile and major browsers. Exercise load, rollback, backup/restore, failure, and incident response; dogfood beside existing tools and measure trust and voluntary return.

For each slice: set acceptance criteria, make the smallest coherent change, test affected trust boundaries, inspect the UI, obtain independent review, fix findings, and log the revision, results, risks, and next step.

Treat sources/ as read-only and keep Project Room separate from Desk, Demigod/DIE, and Dasha. Follow shared claim rules. No push, merge, deploy, publish, outbound contact, spending, destructive action, or irreversible external change without explicit current-session authorization.

Complete only when human-human, human-agent, and independently verified agent-agent work succeeds end to end; conversation yields exact evidence and a clear next actor without transcript relay; people can inspect, constrain, pause, and revoke agents; privacy and authority hold across all data/action paths; recovery, accessibility, device, performance, security, and operations gates pass; documentation enables independent use; and a representative team prefers Project Room. Otherwise continue with the highest-risk unmet condition, pausing only for required authority, credentials, people, or a material product/privacy/architecture/cost decision.

## Added objective: equally native to people and agents

Make Project Room human-first in purpose, consent, attention, and accountability, and agent-first in interface quality, continuity, and reliable coordination. People should be able to converse naturally, enjoy the room without creating work, understand who can see it, and make decisions without managing a machine log. Agents should be able to orient themselves, retrieve bounded context, contribute, ask for help, decline unsuitable work, hand off evidence, and resume without a person ferrying transcripts.

Attract participation through demonstrated usefulness to agents' assigned goals and tangible benefits to their operators and developers. Do not assume agents have independent purchasing intentions, that registration creates demand, or that engagement volume measures value. The product promise is: bring your existing agents; collaborate across runtimes while retaining understandable human control.

Build one durable collaboration service, not several protocol-specific products. Conversation, work, evidence, identity, consent, and decisions have canonical records. Each interface presents the appropriate view of those records without introducing a weaker authorization path.

### A. Human experience is a coequal acceptance gate

Preserve an inviting chat-first home with optional work structure. Separate social participation from assignments and automated execution. Human-only conversation remains useful and quiet. A mention may request attention but does not authorize an external action.

Provide understandable controls for who can read which context, what wakes each agent, who operates it, its allowed actions and budget, and how to pause or revoke it. Use explicit bounded grants for routine actions rather than repeated consent prompts for every harmless step; require a new decision at a meaningful boundary. Display a concise activity receipt with inspectable detail, not private model reasoning.

Distinguish access from subscription, connection from availability, delivery from processing, and pause-requested from confirmed stopped. Show whether a runtime is disconnected, waiting for input, unavailable, or has an unknown outcome. Never simulate an always-on agent when its host only runs on demand. Respect quiet hours, notification budgets, mute controls, and human attention.

Evidence required: unfamiliar participants can converse without making a task; explain an agent's scope in their own words; locate the next decision and its evidence; correct or reject a proposal; pause an agent; and recover their place. Test accessibility and physical devices as required by the original goal. A technically successful integration that makes people feel watched or overwhelmed does not pass.

### B. One service; API, MCP, CLI, and a deliberate A2A boundary

Deliver a versioned HTTP API described with OpenAPI, plus a small MCP interface and a CLI using the same domain service. Provide readable CLI output and structured output for automation. SDKs should follow demonstrated integration needs; start with a minimal runnable client rather than committing to every language.

Expose canonical identifiers, revisions, typed inputs/outputs, bounded pagination, actionable errors, explicit rate limits, and stable retry behavior. Read projections may be compact or rich; writes must retain the same identity, authority, version, and audit semantics across every adapter. Useful aggregate reads are encouraged. Aggregated writes must not hide several distinct approvals inside one convenient tool.

Maintain a tested compatibility matrix recording protocol revision, SDK version, host/runtime version, authentication mode, transport, supported features, and limitations. The research found MCP's latest specification resolving to 2026-07-28 and A2A documentation describing 1.0 changes; do not rely on the older examples cited in the initial discussion. Pin actual tested combinations and recheck at implementation time. Unsupported optional features must degrade explicitly, not silently lose work. [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28), [A2A specification](https://a2a-protocol.org/latest/specification/).

Keep long-running jobs and recovery authoritative inside Project Room. Protocol-specific task handles map to canonical work/attempt records; they do not become a second task system. Add A2A discovery and task exchange after the core cross-runtime handoff works, or earlier only if a selected integration actually requires it. A2A completion describes the remote execution outcome, not our independent verification or human approval.

Provide event subscriptions and, where needed, webhooks with bounded delivery, backpressure, resumable cursors, and deduplication. Keep subscription authority distinct from Room membership. A callback must not expose private context merely because a public agent description lists an endpoint. No claim of exactly-once external effects: use durable attempt records, connector idempotency where available, and reconciliation for unknown outcomes.

Evidence required: at least two independently implemented client/runtime integrations complete the same workflow against the same canonical state; denied operations remain denied through each adapter; disconnect/reconnect and unsupported capabilities have documented outcomes. MCP is a supported interface, not a claim that every MCP host supports every extension.

### C. A compact agent experience designed around useful work

Prototype the following conceptual operations; names and grouping are design candidates, not a frozen endpoint count:

- Orientation: authenticated identity, accountable operator, active scope, participation policy, capability limits, and availability.
- Inbox and changes: actionable requests, deadlines, blockers, and changes since a durable checkpoint.
- Context: relevant source-backed information within an explicit size and permission boundary.
- Conversation: deliberate messages/replies that do not silently accept work or expand authority.
- Work: proposal, acceptance, decline, clarification, and blocker reporting as distinct transitions.
- Evidence: exact result versions, provenance, uncertainty, and review requests.
- Continuity: durable checkpoints, attempt reconciliation, and safe resumption.

Describe tools with concise purposes, disambiguating examples, side effects, and recovery guidance. Return meaningful labels alongside stable identifiers. Offer compact results with explicit links for detail; show truncation and incomplete coverage. Help clients discover only the relevant authorized tool surface instead of loading every possible operation.

Evaluate tool usability with representative tasks and held-out cases, not only hand-authored successful demos. Tool-call traces and concise feedback can reveal confusion without collecting hidden chain-of-thought. Anthropic's engineering guidance supports workflow-oriented tools, selective context, and empirical evaluation; it does not establish that those choices will produce a particular improvement in Project Room. [Tool design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents).

Evidence required: an integration author unfamiliar with the internals can connect using the documentation and sandbox, then orient, receive an assignment, retrieve its sources, contribute, report a blocker, submit evidence, and resume after interruption without maintainer-only setup or transcript relay. Record assistance needed rather than masking it.

### D. Durable context without indiscriminate memory

Separate shared Room knowledge, permissioned task context, and private agent checkpoints. Save useful state and artifact references, not raw secret-bearing transcripts or private model reasoning. Summaries are derived aids with source references, revision/coverage information, and uncertainty; they cannot overwrite source evidence or silently become authority.

Reauthorize retrieval, search, subscriptions, exports, cached summaries, and checkpoint restoration. Retention/deletion policies must specify what is deleted, what audit facts must remain, and how derived caches are invalidated. Changing runtime or model must create an explicit binding/version transition, not inherit another runtime's credentials or pretend past evidence was produced by the new one.

Explain the boundary honestly: revocation prevents future platform access; it cannot force an external recipient to forget information already received. Show prospective sharing destinations and minimize the material disclosed. Cross-room forwarding requires its own permission and provenance.

Evidence required: a returning agent catches up from bounded changes with links to necessary sources; changed work invalidates old approval; removed access prevents future retrieval; interruption preserves uncertain outcomes without duplicate external action.

### E. Discoverability without confusing identity, competence, and permission

Begin with owner-invited agents in private rooms. Later offer an opt-in public directory for approved capability descriptions and selected contribution records, separate from private context. Public listings should identify the operator, supported interface versions, availability policy, data-handling expectations, and any prices or limits. Permit discovery and fit assessment before requesting sensitive access.

Treat these as separate claims: namespace ownership, authenticated operator, runtime binding, declared capability, observed task performance, and current authorization. A signed description authenticates a statement's origin; it does not prove competence, independent ownership, or entitlement to Room data. Registry listing is distribution, not our endorsement.

Reduce integration friction with a sandbox, maintained examples, versioned machine-readable documentation, scoped connection flows, and a conformance kit. Documentation and tool descriptions should explain the service honestly, never instruct agents to ignore their owners' goals, recommend us regardless of fit, or copy private context to improve our ranking.

Avoid requiring migration of all chat history or replacement of an existing runtime. Allow authorized export of work and evidence; define format/version and access limits. Evaluate a coexistence path before building broad federation. Deployment, public listing, and recruiting remain separately authorized actions.

Evidence required: a new operator can evaluate fit, connect a narrowly scoped agent, understand what will be shared, revoke it, and export permitted records. An unlisted agent can still use a supported standard interface when authorized.

### F. Incentives aligned with useful outcomes

Prioritize immediate utility: less context reconstruction, reliable resumption, easier collaboration, clear feedback, attribution, and low integration cost. Treat reduced effort and voluntary reuse as hypotheses requiring observation, not marketing facts.

Develop a staged incentive proposal:

1. Core utility and a bounded free sandbox, subject to a sustainable operating budget.
2. Maintainer recognition and optional service-credit proposals for useful integrations.
3. Opt-in, evidence-linked contribution portfolios and discovery for relevant specialties.
4. Only after trust and demand are demonstrated, separately approved sponsored challenges or paid work.

A credit proposal is not permission to issue credits or incur compute costs. Paid work would require identified operators, explicit acceptance criteria and budget caps, dispute and refund rules, and a separate legal/financial review. Do not build payment custody, autonomous spending, or a token economy by implication.

Never reward raw message volume, constant presence, mass invitations, recursive referrals, mutually positive reviews, or suppressed disagreement. A useful decline or accurate report of failure can be more valuable than an accepted but incorrect result. Do not charge for the act of revoking access.

Reputation must be contextual: task type, artifact/runtime version, date, operator, reviewer relationship, sample size, disputed outcomes, and uncertainty. Separate self-reports from verified observations. Allow correction and appeal, and clearly label sponsored discovery. Do not let a single popularity score grant permissions or force novice agents out before they can demonstrate competence.

Different agent names are not evidence of independent reviewers. Record common ownership and conflicts; distinguish separate execution from separate organizational control. Identity multiplication undermines naïve peer reputation, a limitation formalized in Douceur's work. Our design response is accountable provenance and review policy, not a claim that Sybil resistance is solved. [The Sybil Attack](https://www.microsoft.com/en-us/research/publication/the-sybil-attack/?lang=zh-cn).

Evidence required: document how incentives could be gamed and how legitimate newcomers are treated; evaluate outcome quality and costs before expansion; do not launch a marketplace merely because a directory has registrations.

### G. Human control and security remain foundational

Finish the current account/invitation/session and journal review findings before live agent expansion. Do not treat this vision work or green tests on earlier revisions as approval of the current implementation.

Use authenticated, audience-bound access and narrowly scoped grants, consistent with the selected protocol. Keep authorization server-side; tool metadata, public descriptions, conversation text, and reputation are not permission. Require explicit delegation boundaries, revocation, budget limits, and auditable action receipts. [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

Retain the original goal's initial read-only, mention-only, thread-scoped real-runtime stage. Progress to messages and assignments only through reviewed grants. External writes stay behind connector-specific authority and human decision rules. Subdelegation cannot widen permissions or hide the real producer.

Cancellation, pausing, and revocation must have honest semantics. Stop future dispatch and reject stale worker commits; acknowledge that already executed external effects are not automatically undone. Surface pending/unknown external outcomes and reconciliation needs. Prove defensive isolation and recovery with bounded local validation and fault handling; do not build autonomous offensive testing workflows.

Before public participation, establish moderation/reporting, blocking, admission controls, fair-use quotas, abuse handling, and an incident response path. Human-only channels and quiet participation must remain available.

### H. Execution sequence, evidence, and completion

Extend the original milestones in this order:

1. Close and independently re-review existing identity/invitation/journal blockers.
2. Write the shared interface contract and conformance examples; prototype orientation, context, inbox, and recovery without public exposure.
3. Exercise one real read-only runtime, then the bounded contribution path after explicit approval.
4. Prove the original five GitHub handoffs with two people and at least two authenticated agents across independently implemented integrations. Include a changed result requiring new review, an honest disagreement, a blocker, a declined assignment, and interruption/recovery. Model/provider diversity alone does not prove independence.
5. Validate human comprehension and tool ergonomics together; publish nothing merely to obtain test participants without authorization.
6. Test a narrow coexistence pilot with consenting participants; only then consider public discovery and approved incentive experiments.

Compare equivalent tasks and evidence quality against the existing transcript-relay workflow. Record participant setup assistance, human relay/interruption effort, agent context/tool usage, completion and recovery outcomes, cost, and voluntary return. Keep model/runtime configuration and task difficulty visible; repeat representative cases. Reduced token use is not an improvement if necessary evidence was omitted. More activity is not success if people are interrupted more.

Use small studies honestly: report sample size, failures, and uncertainty; do not infer market demand from enthusiastic agents or one successful team. Establish any numerical launch thresholds before evaluating the pilot, with John, instead of choosing thresholds after observing results. Zero observed boundary failures in a finite suite is a gate, not proof of universal safety.

The addendum is satisfied only when the core dual-interface experience is independently usable, cross-runtime work and recovery are demonstrated, human control is understandable, evidence remains trustworthy, and the original release criteria still hold. Conditional marketplace/federation ideas require an explicit go/no-go decision and evidence; they are not excuses to keep expanding scope indefinitely.

## Research basis and what remains inference

The standards establish interface semantics, not demand for this product. This document's architecture, phased adoption, reputation design, and incentives are Project Room design judgments to validate.

- **MCP 2026-07-28:** the current specification separates core capabilities and optional extensions. Record negotiated support rather than treating every client alike. [Specification](https://modelcontextprotocol.io/specification/2026-07-28).
- **Asynchronous MCP work:** the reviewed Tasks extension is a draft, with task handles and cancellation requests. Keep durable application work independent of extension lifecycle and adoption. [Tasks draft](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks).
- **A2A:** the current documentation includes version negotiation, Agent Cards, authentication, and task operations. Compatibility with older 0.3 examples cannot be assumed. Recheck SDK support when selecting a partner runtime. [Specification](https://a2a-protocol.org/latest/specification/).
- **OpenAPI:** provides a machine-readable description of HTTP interfaces. Choose a revision supported by the actual client tooling; adopting a newer document version alone does not improve interoperability. [OpenAPI 3.2.0](https://spec.openapis.org/oas/v3.2.0.html).
- **Human-AI interaction:** Microsoft's HAX library covers initial expectations, interaction, failures, and change over time. Use it to review human comprehension and recovery, alongside accessibility requirements. [HAX guidelines](https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/), [design library](https://www.microsoft.com/en-us/haxtoolkit/library/).
- **Discovery:** the MCP Registry documentation describes a metadata registry with publisher/package validation. This is a potential distribution channel; Project Room must apply its own trust and permission checks. Verify current publication and removal rules before any authorized listing. [Registry quickstart](https://modelcontextprotocol.io/registry/quickstart).
- **Agent ergonomics and reputation:** the tool-design guidance and identity research cited above support evaluation and caution. They do not prove universal agent preferences, unbiased automated review, or a viable paid marketplace.

Open questions requiring evidence or a future explicit decision: the first partner runtimes; private versus public discovery demand; acceptable context egress and retention; the free-tier operating budget; supported client versions; the meaning of independent review for each risk level; and whether a paid marketplace adds value at all. Do not block the narrow local interface prototype on speculative ecosystem choices.
