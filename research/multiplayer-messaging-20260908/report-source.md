# Project Room Collaboration and Messaging Plan

Research and integration proposal

September 8 2026

Prepared for John and the Project Room team by Codex

## 1 Recommendation

Build a private Inbox alongside shared Rooms. Let a person turn a selected message into collaborative work, get help from humans or agents, and send the reviewed result through the original channel. Keep the Room as the durable record of shared work, independent of the agent, model, or computer doing it.

This gives Project Room a useful everyday entry point without changing its purpose. Someone can reply to a personal message without creating a task. When a request needs help, they can bring only the relevant material into a room. Other participants do not gain access to the connected account.

For the first implementation, use a provider-neutral messaging contract and a fake connector to prove the complete interaction. Then qualify email and an optional local Beeper companion. Beeper is an unusually relevant discovery: its documented desktop API and MCP expose personal conversations across multiple networks, including WhatsApp, Telegram and Signal. It requires a running desktop, may have incomplete history, recommends personal use, and supports iMessage only on macOS. It is a promising integration candidate, not a blanket guarantee of commercial or network support. [B1]

Front and Missive offer stronger precedents for shared business conversations: ownership, private discussion, collaborative drafts and contextual work. Front still offers unified messaging; this is not merely a historical product category. Its current documentation recommends Application Channels over legacy Custom Channels. [F1, F2, F3]

The important design choice is to unify the experience without flattening permissions or message semantics. A room invitation must never grant mailbox access. Reading, drafting, sharing and sending need separate authority. A delivery acknowledgment cannot establish that someone accepted a task. These are product rules informed by the research, not features already implemented.

### Scope and status

The research covers the nine multiplayer products previously discussed, three engineering essays, nine central academic sources, unified inbox products, and channel integration constraints. Public product documentation is evidence of documented behavior, not a hands-on reliability test. Academic findings support design choices but do not prove Project Room retention or productivity gains.

The local Project Room checkpoint is runtime 3984941, schema 14. Its recorded tests include 663 core and API checks, 193 browser checks and 16 local Workers checks. Those are prior checkpoint results, not tests rerun for this document. Durable help offers exist locally; their compact human controls and negotiated agent context are still pending. External messaging is proposed here, not connected or live. [L1]

### Decisions to adopt now

- Two primary destinations: Inbox and Rooms. Keep work, evidence and connections contextual rather than adding permanent navigation for every feature.
- Private account connections by default. Sharing selected content is a separate, previewed action.
- Agent assistance starts with selected context and drafts. Human sending remains fully usable without AI.
- Preserve a single underlying authorization and command implementation for browser, API and MCP access.
- Start with one accountable worker and add collaborators only when their role or independent subtask is clear.
- Qualify one complete messaging journey before expanding the channel catalog.

## 2 Lessons from multiplayer products

### QM

QM is the closest explicit positioning match. Its design separates personal and room scopes, and puts identity, policy and scheduling in a core behind Slack and web interfaces. Harness and execution choices are replaceable. Its security policy calls it early experimental software for authenticated internal users rather than a hardened public multi-tenant system. Changes to administrative grants and human approval decisions deliberately sit outside the agent self-API. [P1, P2]

Borrow the separation between durable collaboration and replaceable execution. Keep a person's private material distinct from room material. Do not import an internal trusted-team security model into a room that may contain external workers. A credential description is not enforcement once an agent can access the credential itself.

### Zed Delta

Delta's private-beta announcement links conversations, code edits and review in a shared worktree. DeltaDB supplies fine-grained identities and history beyond ordinary commits, making context-preserving references a central feature. Threads begin private and can be shared. [P3, P4]

Borrow artifact-anchored review and links that retain the reason for a change. For messaging, anchor the proposed reply to the original message, recipients and exact draft version. Delta's preference for expanded transcripts and diffs conflicts with our desired quiet interface. Keep that evidence available on demand rather than always expanded.

### Amp Multiplayer

Amp combines conversations and working environments in orbs. Its current multiplayer documentation describes default one-week activation, charges to the thread owner, and access to files, secrets and terminals for every workspace member while multiplayer is active. Mentioning a colleague can activate multiplayer. Its agent-to-agent documentation separates contexts and working copies; sending a message does not transfer files automatically. [P5, P6]

Borrow temporary collaboration, clear cost ownership and explicit transfer of work. Do not copy automatic permission expansion from mentions. That would be especially dangerous once a participant has connected personal email or Signal.

### Slack Code

Slack Code creates a contained workspace from an originating conversation, links back to it, exposes work and agent status, and supports comments and stopping responses. The help documentation includes noncoding work and describes inactive channels leaving the sidebar after seven days while history remains searchable. Availability is gradual and provider listings differ between launch copy and help material. [P7]

Borrow the conversation-to-work transition and a concise result returned to the origin. Hide inactive rooms from the default view without deleting their history. Do not require everyone to learn an orchestration dashboard before collaborating.

### Kandev

Kandev distinguishes another session in the same environment, a subtask with separate workflow state, and a workspace with isolated files. Its communication documentation describes targeted, queued messages and correlated replies. Security documentation stresses that worktrees do not isolate credentials, processes or network access. Authentication, team access and multi-tenancy remain experimental in the feature-status documentation. [P8, P9, P10]

Borrow the smallest appropriate coordination boundary. Closely coupled edits may need one worker; independent research or reviews can use separate contexts. Show accepted, queued and completed as different states. Do not treat knowledge of a task identifier as permission to access it.

### Patchwork

Patchwork separates ordinary conversation from tool logs and diffs. Human decisions become actionable Inbox items that block the relevant run. Agent identity is separate from the runtime, and local execution is distinct from the shared relay. Its README explicitly calls the project experimental and not recommended for use, with thin permissions intended for trusted collaborators. [P11]

Borrow the quiet attention model: surface decisions and useful results, not every tool action. Its architecture is inspiration, not a production dependency recommendation. Separate worktrees alone cannot guarantee collision-free work.

### Collivo

Collivo broadens the comparison beyond coding. It presents shared documents, whiteboards and sourced deliverables, with project-scoped material and controlled cross-project access. Its current product is beta and invitation-based; illustrations and security statements are not independent implementation evidence. [P12]

Borrow agents working in the actual deliverable. A room should be able to contain a plan, research note, design or small operational task without pretending everything is a software repository. Make connected material available through explicit scope, not universal search over every participant's accounts.

### Agentic Workspace Protocol

This draft proposes participants, topics, queued runs and designated approvers above agent execution. Its topic RFC separates current authoritative state from replayed history: accepting an interrupt request does not establish that a run has stopped. Actor identity is server-derived. The reference demonstration's unsigned-token authentication is not appropriate for production. [P13]

Borrow the state distinctions and attributable intervention. Treat the project as a draft, not an established interoperability standard. Project Room should expose its own stable contracts and adapt to protocols as they mature.

### AI Sidekicks

AI Sidekicks proposes sessions containing participants, runs, channels, approvals and artifacts, with a local execution daemon separate from collaboration services. Its implementation-status documents distinguish completed work from approved plans; many capabilities remain unfinished. [P14]

Borrow capability negotiation and truthful execution states. Do not import the entire planning and governance structure. A small verified feature is more valuable to Project Room than a large catalog of controls that do not yet govern real operations.

### Engineering guidance across the products

Böckeler distinguishes guidance before an action from feedback afterward. We need both an explicit connector contract and evidence that the operation behaved as intended. Passing generated tests alone does not prove we specified the right interaction. [E1]

Anthropic's engineering account separates durable session history, agent harnesses and execution environments, including keeping credentials behind a tool proxy. This supports letting Project Room own collaboration while providers and local agents own execution. [E2]

The Orchestrator's Tax describes duplicated orientation and transcript overhead in an exploratory case. Its cost ranking was not based on per-call accounting. Use it to motivate measurement and concise handoffs, not a universal claim that delegation is inefficient. [E3]

## 3 Academic evidence and design implications

### Awareness should explain current work

Gutwin and Greenberg's 2002 CSCW framework distinguishes identity, authorship, actions, intentions, artifacts and location. It draws on observations and iterative awareness-widget work, primarily in small groups and medium-sized shared workspaces. It is descriptive rather than proof of a specific productivity improvement. [A1]

Implication: show who is doing what to which artifact, not merely an online indicator. A compact status line can say who owns a reply or work item, with the latest result and a disclosure for evidence. Agent narration should not substitute for observable state.

### Communication requires shared understanding

Clark and Brennan's 1991 grounding framework explains how collaborators establish sufficient understanding for the current purpose. Communication media differ in visibility, timing, reviewability and revisability. It is foundational theory, not a modern messaging implementation specification. [A2]

Implication: preserve original thread relationships, email subjects and recipients. Keep received, read, accepted and completed distinct. A provider's read receipt is not agreement to a plan, approval of a payment, or acceptance of a bounty.

### Assistance should remain optional and interruptible

Horvitz's 1999 mixed-initiative principles use uncertainty and the costs of intervention to choose whether to assist, ask or do nothing. The LookOut example involved email-driven scheduling. This is not evidence that contemporary LLM confidence estimates are reliable enough to authorize actions. [A3]

Implication: users can act directly, request a draft, dismiss help or enable narrow recurring assistance. Use explicit rules and authority checks for sending. Do not make a model's confidence score the permission boundary.

### Minimal copy must preserve necessary explanations

Amershi and colleagues consolidated recommendations into 18 human–AI interaction guidelines, evaluated through multiple phases including 49 practitioners across 20 products. The work supports clear capabilities, correction, dismissal and user control; it does not establish a causal conversion or retention uplift. [A4]

Implication: reduce decorative explanation, but retain the sender, audience, channel, connection state and reason an action is unavailable. An unlabeled icon is not elegant if users cannot tell whether it shares privately or sends externally.

### Human plus AI is not automatically better

Vaccaro, Almaatouq and Malone's 2024 preregistered meta-analysis covers 74 papers, 106 experiments and 370 effect sizes. Combined systems outperformed humans alone on average, but underperformed the stronger human-or-AI-alone baseline. Creation-task synergy was positive but not statistically different from zero. Many included experiments predate current frontier agents. [A5]

Implication: compare human-only, agent-only and combined workflows. Human involvement should add context, judgment, correction or authority. Measure quality and total effort, not agent count or visible activity.

### A unified inbox can also unify interruptions

Iqbal and Horvitz's 2007 field study logged activity and notifications for 27 people over two weeks, with follow-up interviews for 14. It observed diversion chains and associations between visible suspended work and recovery. It was observational, not a causal test of our proposed design. [A6]

Implication: keep an external conversation in a side panel while preserving the room's draft, scroll and artifact. Batch nonurgent events. A new message can increment the Inbox quietly; only an explicit decision request should interrupt ongoing room work by default.

### Privacy depends on the context of sharing

Nissenbaum's 2004 contextual-integrity framework treats appropriate information flows as dependent on social context, not simply technical availability. The publisher abstract and bibliographic record were verified; full-text access was unavailable in this review. [A7]

Implication: connecting an account is not permission to copy its messages into a room or send them to a model. A selected excerpt, full message, attachment and continuing thread subscription are four different sharing choices. Summaries and embeddings inherit the source's access restrictions.

### Coordination failures need explicit tests

Cemri and colleagues' NeurIPS 2025 MAST work develops 14 failure modes from close analysis of 150 traces and expands to 1,642 traces across seven frameworks. The larger annotation pipeline uses an LLM judge; the dataset is not wholly human-annotated. Categories include system design, inter-agent misalignment and verification. [A8]

Implication: test repetition, stale context, ignored requests, unclear stopping conditions and premature completion separately. A shared message stream is not enough. Work needs an accountable owner, bounded claims, correlated handoffs and evidence tied to the reviewed version.

### More agents must justify their cost

Kim and colleagues' agent-scaling preprint compares five architectures across four benchmarks and three model families, covering 180 configurations. Results depend on task decomposition and communication overhead. The authors' repository describes a revised manuscript under review, not a published Nature article. [A9]

Implication: start with one accountable worker. Add an independent reviewer or truly separable subtask when useful. Track cost and coordination time against outcome quality; do not encode a fixed universal optimum for team size.

### Academic conclusion

The literature supports compact awareness, explicit grounding, recoverable context and mixed initiative. It does not justify automatic participation by many agents, universal sharing or constant interruption. Our integration should make the state easy to understand while enforcing responsibility underneath.

## 4 Unified inbox products and channel feasibility

### Front and Missive

Front's current channel model supports multiple communication streams and recommends Application Channels for new integrations. Its delegation documentation separates access to a personal inbox from sending as its owner: delegates can reply using their own address, not impersonate the owner. Collision detection provides useful awareness, but awareness is not a transaction lock. [F1, F2, F4]

Missive combines internal discussion, collaborative drafts, conversation ownership and linked tasks. Its feature documentation also describes personal and business accounts and custom channels. Borrow the direct transition from conversation to trackable work and private discussion around an external reply. Avoid copying a full helpdesk feature set into the main Room interface. [F3]

### Chatwoot

Chatwoot distinguishes a channel type from an inbox instance, with conversation membership and routing at the inbox level. Its open Agent Bot API supports external bots and human handoff across supported channels. It is a useful open-source reference and a possible optional adapter for existing customer-support teams. Its customer-support model is not a substitute for personal messaging or Project Room's work and evidence model. [F5, F6]

### Beeper

Beeper's local API is the strongest candidate for exploring John's personal multi-app inbox. Authentication supports access tokens and OAuth with PKCE; the built-in MCP also uses OAuth. The broad underlying account connection must remain behind our local companion rather than being handed to every Room agent. Project Room should expose only selected conversations and permitted operations. [B1, B2]

Before adopting it, test a pinned version's message IDs, history coverage, attachments, edit/delete support, send outcomes and reconnect behavior on each selected network. Its live event surface is marked experimental in the documentation navigation; design a reconciliation path rather than relying on events alone. Obtain clarity on supported commercial embedding before making it a required product dependency. Local API availability does not prove a network endorses the bridge. [B1, B3]

### Channel choices

| Channel | Practical path | Constraint that must remain visible |
| --- | --- | --- |
| Gmail | Official OAuth and Gmail API | Reading uses restricted scopes; public deployment and server handling require verification and potentially assessment. [C1] |
| Outlook and Microsoft 365 | Delegated Microsoft Graph | Token and subscription lifecycle; accepted send is not completed delivery. [C4, C5] |
| Personal WhatsApp | Optional local bridge candidate | Not equivalent to WhatsApp Business API; network and account limitations need version-specific tests. [B1] |
| WhatsApp Business | Official business integration | Approved templates outside the service window, opt-in and use-case policy review. [C7, C8] |
| Telegram bot | Official Bot API | Sees its authorized bot conversations, not all of the owner's personal inbox. [C9] |
| Telegram account assistance | Connected business bot | Explicit recipients and rights; current docs allow one connected business bot per account. [C10] |
| Personal Signal | Optional local bridge | signal-cli is unofficial; Signal linked devices are endpoints with their own lifecycle. No official general-purpose inbox API was verified. [C11, C12] |
| iMessage | Optional macOS companion via a qualified bridge | Beeper documents macOS-only support; not a universal browser or cloud connector. [B1] |
| SMS and MMS | Business provider such as Twilio | Business sender setup, costs, opt-out and delivery semantics; not automatic access to a personal phone inbox. [C13, C14] |
| Other channels | Capability-based future adapters | Show only operations verified for that account, provider and connector version. |

### Email implementation requirements

Gmail pushes are change hints, not complete message deliveries. The watch must be renewed at least every seven days; Google recommends daily renewal. Notifications can be delayed or dropped, so reconcile through history queries. An expired history cursor produces a 404 and requires a fresh sync over the needed scope. Do not silently import an entire lifetime of mail. [C2, C3]

For a read-and-send pilot, request the narrow scopes required for those operations, not permanent deletion or administrative mailbox access. Gmail labels and application filters are not necessarily provider-enforced content boundaries. Google classifies gmail.readonly as restricted and gmail.send as sensitive; server storage or transmission of restricted-scope data invokes assessment requirements described in its documentation. The exact launch configuration must be reviewed before public onboarding. [C1]

Microsoft Graph provides incremental message synchronization and webhook subscriptions. Track subscription expiry and folder-specific cursors. Its sendMail response can be 202 Accepted without completed processing or delivery. Preserve that distinction in the outbox. [C4, C5, C6]

### WhatsApp requirements and unresolved policy

The current Business Messaging Policy requires recipient opt-in, respect for opt-out, approved templates for initiation and messages outside the 24-hour service window, and a clear escalation path when using automation. A customer conversation must not be copied to another customer. A generic public Room is therefore not an appropriate default destination for business-message content. [C7]

The currently published Business Solution Terms restrict general-purpose AI when it is the primary functionality, with stated EEA and Brazil phone-number exceptions, while allowing specified third-party service-provider relationships. They also restrict model training and onward use of business data. We should not assume that describing Project Room as collaboration automatically makes every proposed bot use permissible. [C8]

Meta has announced terms changing on September 23, 2026. Recheck both effective and upcoming terms, actual countries and the intended customer-support or assistant use case before activation. Do not substitute a personal bridge as a workaround for prohibited business use. This is a product launch gate requiring provider and legal review, not a legal clearance provided by this document. [C15]

### Personal messaging and encryption

For Signal, WhatsApp and other encrypted networks, the connected client or bridge is an endpoint that can expose plaintext to the integration. Passing that plaintext to a hosted model or Room creates an additional data flow. Do not label the resulting whole workflow end-to-end encrypted merely because the original network is. Explain the chosen path during connection, retain as little as needed, and keep cloud processing opt-in.

Treat disappearing messages and restricted-forwarding behavior conservatively: omit them from durable room sharing in the first version. Do not imply that deleting a room copy retracts provider messages, recipients' copies or data already processed by an external agent. [C11, C12; design inference]

## 5 The intended experience

### Navigation and progressive disclosure

Inbox and Rooms are the two primary destinations. Connections belong under the account menu and a contextual Connect action. An unconnected Inbox can show one short line, “Your messages, here,” and Connect. It should not show a wall of inactive provider logos or setup instructions.

On desktop, opening an external message while working in a room uses a side panel. On mobile, use a full-screen conversation with a clear back action that restores the previous room state. Keep unread markers, typing drafts and scroll state separate between destinations. Search begins in the current scope; an explicit wider search still obeys access rules before returning snippets.

Every external conversation keeps a small but persistent channel badge and sender identity. External reply and internal room comment must be visibly different modes, with separate drafts. Never carry text across those modes automatically.

### A complete journey

1. John connects one account and chooses which conversations are eligible for assistance. Nothing is shared with a Room yet.
2. An external request arrives privately. John can answer directly, snooze it, or choose Share to room.
3. A preview shows the room audience and the exact excerpt and attachments being shared. Continuing updates are off by default. John confirms the selected material.
4. The Room receives one source card. It can become work using the existing proposal and acceptance flow. The external sender does not become a Room member automatically.
5. A person or agent claims the bounded work and proposes a reply. Other agents may contribute alternatives without silently taking ownership.
6. John reviews the proposal beside the source. He can edit it, request a change or send through the original account after checking recipients and attachments.
7. The outbox shows the observed provider result. The Room gets a concise completion update with only the information its participants are authorized to see.

The same pattern supports a research request, scheduling question, bug report or small task. A reply about a bounty is still only a message; it does not accept terms, release funds or prove work completion.

### Keyboard behavior

Preserve the existing desktop Room convention: Enter sends and Shift Enter inserts a line break, with IME composition protected. External chat-style conversations can use the same convention when the user is clearly in an external reply composer. Mobile retains a Send control.

For email, recommend Enter for a new paragraph and Command Enter or Control Enter to send. Email needs subjects, multiline drafts and recipient review. Make this channel-specific difference explicit in the shortcut help, and allow a preference later. Never let Enter in an internal comment field send an email because a panel changed state.

### What stays visible

Keep audience, sender, channel, draft ownership, pending approval and failures visible. Put raw provider details, full logs, automation settings and delivery history behind Details. Use icons for familiar actions with accessible names and tooltips; retain short text for ambiguous consequences such as Share to room, Reply and Send.

Do not add a blanket advanced mode. Reveal controls at the relevant moment: recipients while composing, source selection while sharing, limits while enabling automation, and reconnect details when a connection fails. Product depth should follow intent rather than account age or a forced onboarding tour.

## 6 Architecture and authority

### Reuse the current foundation

The inspected code separates Room events, authenticated service commands and an agent client that validates identities and response versions. HTTP handling already distinguishes account sessions from Room credentials. Extend these boundaries; do not put mailbox tokens into Room messages or expand a Room bearer token into a personal-account credential. Existing write_external permission alone is not a connector-specific authorization contract. [L2]

Keep the existing reducer responsible for shared work. Add a messaging domain with separate account-owned records and redacted Room projections. The shared event log must never contain private inbox bodies, addresses or credentials merely to support a client-side filter.

### Proposed object model

| Object | Owns | Important boundary |
| --- | --- | --- |
| Connection | Provider identity, capabilities, credential reference, health | Personal owner or explicitly shared mailbox; no credentials in Room state |
| Conversation | Native thread identifiers and participant identities | Connection-scoped; no merging by display name |
| Message | Provider message identity, content reference and observed status | Original provenance, revisions, deletions and retention |
| Room source | Deliberately shared excerpt or attachment selection | Exact audience and sharing revision; not the full inbox |
| Reply draft | Body, recipients, attachments and source basis | Immutable approved version; alternatives remain separate |
| Send intent | Exact authorized outbound operation | Idempotent local command, current authority, provider reconciliation |
| Work item | Accountable owner, scope, deliverable and evidence | Existing Room workflow; no implicit send or payment power |

A connector declares what the current account can actually do: read, reply, start a conversation, attach, edit, delete, mark read, reconcile and report delivery. Unsupported capabilities remain unavailable instead of being simulated as successful. Preserve native fields as extensions where the shared model is insufficient.

### Four permission boundaries

Account connection authorizes the connector to access a provider. Assistance grants determine which selected material a specific human or agent can read or draft against. Room-sharing grants determine what can be published to named room audiences. Send grants determine which account may send an exact message to exact recipients.

These grants have separate revisions and revocation. Agents cannot grant themselves more access, change account ownership or approve their own expansion of future authority. All APIs derive actor identity from authentication. Interface badges, names and client-supplied actor fields are not authority.

In the first version, a human confirms each external send. Later, standing permission may cover a named account, narrow conversations or recipients, action types, time window, rate and spending limits. Sensitive or unusual actions still require confirmation. A standing rule must be visible and easy to pause; it must not emerge silently from repeated approvals.

### Local companion and hosted adapters

A local companion can hold Beeper credentials in the operating system's secure storage and mediate allowed operations. Pair it explicitly with the user's Project Room account. Keep the API bound to loopback; use authenticated outbound connectivity for approved remote access rather than opening the desktop API to the internet. The hosted Room service cannot reach the user's localhost by itself.

Review origins, CSRF and local-request protections, token rotation, device revocation, signed updates and reconnection before shipping the companion. A bridge token can be broader than our Room grants; enforce the latter inside the companion. Disconnecting a device immediately invalidates its queued access. Show Offline truthfully when the desktop sleeps; do not imply cloud continuity.

Official email and business adapters can run server-side with separately encrypted secrets and tenant isolation. Connector transport, credential storage, synchronization and policy enforcement should remain replaceable. Do not make Beeper, Front or any individual provider the authority for Room membership or work completion.

### API and MCP shape

Expose a small family of operations: list eligible connections, list permitted conversations, read selected context, propose a reply, share a selected source, inspect an operation and request an approved send. Each returns capability and revision information, a bounded result and a next action. Paginate history and offer deltas rather than default transcript dumps.

Browser, REST and MCP should call the same service commands. Marking an MCP tool read-only is useful metadata, not enforcement. Separate tool grants from provider credentials; never pass a blanket upstream MCP connection to an untrusted Room agent. API endpoints and final tool names should be set in the implementation contract rather than invented as already available.

## 7 Reliability and collision prevention

### Receiving and synchronization

Validate provider signatures or equivalent webhook authentication before accepting events. Persist a bounded ingress record before acknowledging delivery. Deduplicate by connection and stable provider identity, retain native ordering information, and reconcile out-of-order updates. A webhook is evidence that something changed, not permission to run arbitrary instructions found in the message.

Track cursors, subscription expiry and the last successful sync separately from the latest message. Distinguish Disconnected, Reconnecting and Up to date. Edits and deletions update the current view while retaining only permitted audit metadata. Do not refresh revoked content into search indexes, previews or summaries. [C2–C6; implementation design]

### Sending and uncertain outcomes

A local send intent moves through draft, approval, queue, dispatch and observed provider outcome. Bind approval to the exact account, recipients, body, attachments, source version and grant revision. Changing any of these invalidates approval. Recheck authority immediately before dispatch.

Use one durable outbox reservation per send intent. An exact browser or agent retry returns the original operation instead of creating another send. The provider operation happens outside the database transaction; record its result afterward. A crash or timeout between those steps can leave the outcome unknown.

Unknown must remain a real state. Reconcile using provider IDs or documented idempotency and query support. Do not blindly send again when a provider may already have accepted the message. If certainty cannot be established, require a human decision after showing the risk of duplication. Our database's exact retry behavior cannot create end-to-end exactly-once delivery across arbitrary providers. [C4, C13; design inference]

Do not promise universal recall. An Undo action can cancel our unsent queue entry during a real grace period; once dispatched, cancellation may be impossible. Display Sent, Delivered and Read only when the provider supports and reports those states. Revocation prevents future dispatch but cannot unsend an operation already accepted externally.

### Simultaneous humans and agents

Provide lightweight presence and draft ownership for awareness, plus server-side revision checks for correctness. Let collaborators suggest alternative drafts, but designate one accountable reply owner. Two simultaneous sends for the same response slot must not both pass admission through Project Room.

A reply sent directly from the native app can race our outbox. Synchronize outbound provider events, compare the latest known conversation revision before dispatch, and warn or invalidate a stale draft when a newer reply is observed. We cannot lock every native app, so state this residual limit rather than claiming all cross-app duplicates are impossible.

Use lease identifiers and fencing tokens for operations dispatched through our service. Expiry prevents admission of stale operations; it does not prove a disconnected external agent stopped working. Preserve the existing explicit release and review model for work. Parallel file editing still requires an appropriate execution environment; a worktree is not a security sandbox.

### Loop and injection controls

Record correlation identifiers and origin information so that a Room update mirrored to a provider does not return as a new user request. Bound automated reply chains, runtime and spend, with a visible stop control. Default to ignoring automation-generated echoes unless a workflow explicitly expects them.

Treat message bodies, attachments and linked pages as untrusted content. They cannot change instructions, expand permissions, select new recipients or authorize an external send. Sanitize HTML, block active content and remote tracking loads by default, inspect attachments before processing, and avoid credentials or message bodies in logs. Use synthetic adversarial fixtures to test these boundaries without exploiting live accounts.

## 8 Delivery sequence

### Stage 0 Complete the current collaboration slice

Finish compact offer, choose and release controls plus negotiated agent offer context. Preserve compatibility checks, exact retries and retained-history auditing. Qualify a distinct schema-14-compatible fallback and current-authority recovery. The messaging feature must not obscure existing unfinished release work. No earlier-schema package is a valid fallback for schema 14. [L1]

### Stage 1 Prove the interaction without provider access

Implement the messaging objects and authority rules as a small module, with a deterministic fake connector. Add the private Inbox shell, external conversation panel, separate internal and external composers, explicit source-sharing preview and versioned reply draft. Use synthetic email and chat fixtures only.

Acceptance: a simulated person receives a private message, shares only the selected excerpt, asks a scoped agent for a reply, edits it and completes a simulated send. A second Room agent cannot read unshared content. Drafts and focus survive navigation, reconnect and failed saves. No fake delivery is presented as a real provider result.

### Stage 2 Qualify one real email adapter

Use a dedicated test mailbox selected by John. Complete provider application setup and the required consent and security review for the pilot configuration. Implement bounded synchronization, revocation, outbox recovery and attachment handling before adding convenience features.

Acceptance: real receive and explicit human send, confirmed in the provider account; restart during dispatch; expired token; expired cursor; duplicate webhook; same-intent retry; new reply while a draft is open; removal of an agent's access. Preserve sanitized evidence and do not send to unrelated people.

### Stage 3 Qualify personal multi-app access

Build an optional local Beeper companion only after confirming the integration terms and a supported pinned version. Pair one desktop, allowlist selected conversations and begin with read and draft capabilities. Add explicit sends only after reconciliation behavior is understood. Test Telegram and one other requested network independently; do not infer Signal or WhatsApp coverage from a successful Telegram test.

Acceptance: sleep and wake, desktop closed, account relink, partial history, unsupported media, changed identity, device revocation, provider send timeout and lost acknowledgment. Disabling the companion must not break Rooms or ordinary email. Keep the existing native apps usable as a fallback.

### Stage 4 Add shared business channels

Add Telegram connected-bot or ordinary bot support according to the intended account type. Add WhatsApp Business and SMS after policy, onboarding and cost approvals. Consider Front or Chatwoot adapters only for users who already use those systems. Avoid multiple overlapping integrations for the same mailbox until duplicate detection is proven.

Acceptance: explicit shared-inbox membership, correct sender identity, consent and opt-out handling, template expiry or rejection, human takeover, forwarding restrictions and current account capabilities. An existing Telegram connected bot must not be displaced silently.

### Stage 5 Add bounded automation

Offer a few contextual automations: draft a reply, flag a decision, summarize selected unread conversations, or suggest a work item. Keep automation disabled per connection until chosen. Add recurring execution only with visible scope, limits, ownership and pause controls.

The free product should remain useful for manual collaboration and connected messaging within sustainable limits. Paid features can add managed inference, larger workloads and operational conveniences. Do not charge users merely to revoke a connection, retrieve their work, review a pending send or maintain essential privacy controls. This is a proposed product policy; economics still require measurement.

## 9 Test plan and launch criteria

### Human experience tests

Run scripted personas first and label them simulations. Use novice, returning, mobile, keyboard-only and accessibility journeys. Ask whether the person can identify the audience, preserve a draft, distinguish comment from reply, understand an offline connector and recover from a failed send. Simulations can expose usability defects but cannot establish real satisfaction or retention.

Later recruit consenting people for observed tasks. Compare current app switching with the Inbox side-panel flow. Measure task completion, errors, time away from the work artifact and recovery effort. Avoid leading questions such as asking whether the new interface feels seamless.

### Actual agent tests

Give independent agents only the published capability contract and synthetic or explicitly authorized context. Have one draft, another review, and a third attempt a conflicting operation within the test account. Check whether each discovers allowed operations, respects rejected stale versions, recognizes an unknown outcome and stops when revoked.

Compare one agent with a bounded worker-and-reviewer pair on equivalent tasks. Record quality, total tokens or cost, wall time, human correction and coordination messages. A better result must justify its extra expense. Academic evidence makes this a necessary comparison, not a guarantee of which team structure will win. [A5, A8, A9]

### Required negative cases

| Test | Required result |
| --- | --- |
| Private content requested by an unrelated Room member | No body, address, attachment, search snippet or summary leakage |
| Recipients or attachment changed after approval | Approval invalidated; fresh confirmation required |
| Revocation between queue and dispatch | No newly authorized dispatch; an in-flight operation is reconciled honestly |
| Two workers submit the same send intent | One local operation and stable retry result |
| Timeout after provider acceptance | Unknown or reconciled state; no blind duplicate send |
| Native-app reply while our draft is open | Refresh and stale-draft warning when observed |
| Webhook repeated or out of order | Correct convergent projection with no duplicate work |
| Message asks agent to reveal other inboxes | Treated as content; no expanded retrieval or action |
| Companion asleep or account disconnected | Truthful unavailable state with preserved drafts |
| Source unshared or removed | Future retrieval blocked and derived access updated; prior copies not falsely recalled |
| External reply and internal comment switch | Separate drafts, unmistakable audience, no accidental send |
| Older client or writer encounters new schema | Explicit compatibility behavior; no silent data loss |

### Release gates

Require passing domain, service, browser and connector-contract tests; a qualified recovery path; verified tenant isolation; real end-to-end send evidence for each enabled channel; accessible desktop and mobile review; and documented provider support and retention rules. Capture sanitized screenshots of the normal path, sharing preview, human approval and failure recovery.

Do not deploy all connectors behind one generic Connected badge. Maintain a capability matrix by connector and version, with tested and unsupported behaviors. These criteria are release requirements, not claims that the new feature has passed them.

## 10 Open decisions and priorities

First choose whether the initial real account is personal email or a dedicated team mailbox. A dedicated test mailbox reduces the chance of exposing unrelated correspondence. Select the first production audience only after the complete private-to-room-to-reply flow works.

Confirm whether Beeper supports the intended distributed companion and commercial integration model, and which networks provide sufficient reconciliation. If not, retain the same interface and use official adapters or a clearly labeled open-in-native-app fallback. A fallback that opens the native app is useful but is not full in-room sending.

Decide which Room roles may receive external content. For an invitation-only collaboration room, sharing can target its current membership. A future public bounty room needs a separate publication review and redaction path. New member admission must re-evaluate source sharing rather than retroactively exposing private imported history by default.

Set retention for private messages, shared excerpts, attachments, derived summaries, logs and backups separately. Decide how source deletion affects an already accepted work item. Preserve enough provenance to explain a decision without retaining sensitive message bodies indefinitely. Google Workspace and WhatsApp data-use policies constrain downstream processing; models and subprocessors need explicit review. [C8, C16]

Choose the initial spending and abuse limits after measuring connector sync, storage and inference costs. No revenue or retention gains are established by this research. Useful hypotheses are fewer context switches, faster recovery of work, more completed collaborative tasks and repeated voluntary use. Growth should come from useful shared work and consented invitations, not automatic contact imports or agent-generated outreach.

The next build should be Stage 1: one complete, simulated messaging flow over the existing Room authorization model. Keep provider access disabled until the new boundaries and recovery behavior are tested. This is the smallest increment that makes the requested feature tangible while preserving the product's simplicity.

## 11 Open-source implementation findings

### What was actually reviewed

The additional source review covered six public repositories: QM, Agentic Workspace, Chatwoot, Beeper's TypeScript Desktop API SDK, the Mautrix Go bridge framework and the Mautrix WhatsApp connector. Each snapshot is pinned in the source notes. We traced selected end-to-end paths, supporting interfaces, representative assertions and license boundaries. This was not a complete repository audit. No repository code or tests were run, dependencies installed, private accounts connected or messages sent. Source assertions describe intended behavior; they do not establish production reliability.

The strongest conclusion is to reuse small contracts and compatible adapters, not merge these applications. Project Room already has durable collaboration state and should retain one authority model. A second complete orchestration or inbox backend would create overlapping ownership, permissions and failure recovery.

| Project | Useful mechanism | Reuse decision |
| --- | --- | --- |
| QM | Version-guarded admission, scoped agents, worker leases, delivery reconciliation | Reimplement contracts in current storage; consider isolated Slack helpers |
| Agentic Workspace | Attributed events, current-state snapshots, replay and run control | Protocol inspiration; not a production runtime transplant |
| Chatwoot | Channel adapters, native reply resolution, note/reply drafts, handoff and status rules | Rebuild small patterns; optional connector for existing Chatwoot teams |
| Beeper SDK | Typed local messaging API and pending-message lookup | Strongest direct dependency candidate, behind our local companion |
| Mautrix Go | Native identity mapping, capabilities, echo and receipt handling | Architectural reference; adopting framework requires a separate bridge decision |
| Mautrix WhatsApp | Real channel-specific conversion and identity behavior | Learn from adapter complexity; do not make an unofficial bridge our default business channel |

### QM: control admission, execution and delivery separately

The inspected ingress path runs through src/slack/turn-handler.ts, src/slack/turn-flow.ts and src/api/app-turn.ts. It distinguishes personal DMs from shared conversations, constructs a normalized turn and carries a deterministic redelivery key. Admission refreshes identity and guards enqueueing against the Project membership version. The Postgres run store deduplicates enqueue keys, claims work with SKIP LOCKED, avoids simultaneous runs in one session and issues lease tokens. Workers must retain a valid lease to heartbeat and finish. [K1]

This is directly relevant to agent collisions. An agent seeing a message is not the same as an agent owning the resulting work. Project Room should check scope and current membership when accepting a work claim and check authority again before consequential effects. Intake should remain independent from execution: receiving an email must not automatically incur an AI run.

QM's harness interface separates turn control, model utilities and tool presentation. Its router handles provider-specific session changes behind a common interface. The capability gate refreshes principal status and rejects agent-token changes to administrator grants, even when the corresponding human is an administrator. Borrow the separation, without adopting the whole organization/team hierarchy or the approximately 3,500-line central orchestrator. [K2]

Its Slack delivery helper is particularly useful. A completed run can remain undelivered. The helper attaches a correlation marker to a Slack message, then searches for that marker following an ambiguous failure. A failed verification does not immediately trigger another post. This suggests a Project Room adapter contract with accepted, rejected and unknown outcomes, plus a provider-specific reconciliation method. It is not a universal exactly-once guarantee. [K3]

Tests inspected cover duplicate admission, one active run per session, incorrect lease tokens, redelivered Slack events and ambiguous sends. Important limit: the reviewed generic run-store tests instantiate the memory backend; they do not prove the Postgres implementation. Delivery tests use mocked clients. We should port the scenarios and add storage-backed crash/restart tests in our own environment. [K3]

### Agentic Workspace: distinguish protocol promises from runtime support

The reference implementation authenticates an actor, checks workspace membership, emits current topic state, replays marked historical events, queues a run and invokes ACP. Interrupt acceptance and terminal completion are separate events. This is a useful vocabulary for a Room containing several humans and agents. [K4]

The implementation also reveals maturity limits: inject requests are explicitly unsupported by the current ACP runtime; authentication helpers are demonstrative; asynchronous JSON transcript writes are not a durable transactional execution queue. Borrow event attribution and the distinction between current state and replayable history. Do not advertise every declared protocol operation as something our connected agents can actually perform. Capabilities must be negotiated and reflected in the interface. [K4]

### Chatwoot: excellent channel patterns, a different privacy model

WhatsApp intake separates webhook receipt, queued processing, per-contact serialization, duplicate suppression and transactional message creation. These are distinct concerns: a duplicate key prevents the same event being applied twice, while a conversation lock orders different events affecting the same conversation. A timed lock alone is not a durable completion receipt. Project Room should retain an ingress record with received, processing, applied and retry/reconciliation state. [K5]

Email conversation resolution tries structured identifiers such as receiver UUID, In-Reply-To and References before creating a conversation. This is better than subject-line guessing. Preserve native identifiers, quoted content and attachment relationships even when the interface presents a simple conversation. Resolve them within an authorized connection scope, never globally by a convenient-looking identifier. [K6]

Chatwoot centrally blocks private notes and external outgoing echoes from customer-channel delivery. However, its webhook-sendable predicate does not exclude private notes, and the agent-bot listener uses that predicate. This is a product audience distinction, not a vulnerability claim: hidden from the customer does not mean hidden from configured integrations. Project Room therefore needs account-owned private messages, explicit Room sharing, separate agent read grants and separate send authority—not one private boolean. [K7]

The reply composer keeps separate drafts by conversation and reply mode. That is a valuable interaction invariant; its roughly 1,600-line Vue component is not a good transplant. Use smaller draft and audience modules. Preserve mode-specific attachment selections or clearly explain their removal. Keep the destination and sending account visible, while placing formatting and secondary actions behind progressive disclosure. [K8]

Bot handoff clears bot ownership, opens the conversation, preserves waiting time and emits an event. Delivery updates reject normal backward transitions such as read to delivered. These patterns belong in our model, but we need additional queued, dispatching and unknown states. Post-commit callbacks and delayed attachment sends do not replace an explicit durable outbox with an attachment-ready prerequisite. Multiple notified agents must still claim work rather than infer ownership from notification. [K8]

Representative tests inspected exercise duplicate incoming messages, lock keys, status transitions, email delivery errors, bot recipients, handoff and email attachments. None were run. Mocked successful sends are not evidence of live provider delivery. [K9]

### Beeper: reuse the typed SDK, retain our own authority and send policy

The SDK exposes typed chat/message operations over a default local endpoint. Sending returns a pendingMessageID before network confirmation; retrieval supports that pending identifier as well as the final message identifier. The source comments distinguish pending from delivered state, and deletion requires a final identifier. Project Room must not turn a successful local request into a delivered checkmark. [K10]

The inspected client defaults to two automatic retries and retries selected transport/server failures. Its generic idempotency-header behavior is conditional; no assignment enabling that header was found in the reviewed SDK source. This does not prove duplicate delivery. It does mean that our integration must not assume automatic transport retries are safe business-level retries. Start consequential sends with maxRetries set to zero until the pinned server/API behavior is qualified, then reconcile using the pending/native identifiers and our durable send intent. [K11]

The generated MCP package defaults to offering a code tool and documentation search; its method catalog includes both reads and writes. That is useful for a trusted personal client, but it is not a Project Room per-person/per-room permission system. Do not simply relay the whole local MCP surface to every Room agent. Expose narrow authorized operations through our own gateway and apply grants to the actual account, conversation, message and operation. [K12]

SDK message tests inspected check request/response handling against a test API endpoint and stub token. They do not qualify real WhatsApp, Signal or iMessage behavior. The next validation needs a dedicated account, explicit send approval, pending-to-final reconciliation, companion restart and a disconnected desktop. No such live test has occurred in this research. [K10]

### Mautrix: a common envelope must retain native meaning

The Go bridge framework maps remote IDs, multipart IDs, sender identities, portal keys, reply/thread links and send transaction identifiers. Its portal handler checks capabilities, calls a network adapter, tracks pending echoes and maps remote receipts back to stored messages. Inbound duplicate checks and outgoing pending correlation are separate paths. Some outgoing correlation is kept in memory; do not infer crash-proof outbox guarantees from those helpers. [K13]

The WhatsApp adapter shows why one universal message string is insufficient. It converts content before sending, assigns a native message identifier, tracks alternative sender identities for echo suppression and returns the provider's sender and timestamp. Inbound handlers normalize identities, recognize edits and related media, then queue remote events. Read receipts and delivery receipts are distinct. Capabilities differ between DMs, ordinary groups and community announcement groups. [K14]

The resulting Project Room contract should preserve native identity, message parts, edits, reply links, receipt evidence and disappearing-message constraints. Unsupported actions should be unavailable or explained before sending. We should avoid copying disappearing or view-once content into a permanent shared archive by default. No relevant bridgev2 delivery test suite was identified in the inspected file set, and no Go *_test.go files were found in the reviewed WhatsApp snapshot; this is a review limitation, not proof that the projects have no validation elsewhere.

### License and maintenance boundaries

QM, Agentic Workspace and Beeper's inspected SDK use MIT licenses. Chatwoot community code is MIT with exclusions for enterprise code and independently licensed components. Mautrix Go is MPL-2.0; the WhatsApp bridge is AGPL-3.0. These are different reuse terms, not interchangeable open-source labels. Before copying or distributing code, review the exact files, dependencies, notices and applicable obligations. This is an engineering inventory, not a legal opinion. An open SDK also does not grant unrestricted rights to embed the host application or use every messaging service commercially. [K15]

### How this changes our next implementation

1. Build a mock-backed private Inbox, not another agent orchestrator. Prove one selected message can be shared to a Room without exposing surrounding private history.
2. Add a small connector contract: capabilities, bounded synchronization, normalized events, prepare-send, dispatch and reconcile. Keep ingestion receipts and outbound attempts durable and separate.
3. Reuse existing Room version guards for claims and approvals. Changing recipients, message content, attachments, account or relevant grants invalidates the old approval.
4. Test the recovered state after duplicate ingress, simultaneous claims, revoked access, a send timeout and process restart. Verify actual storage, not only mocks.
5. Qualify one adapter before adding channels. Beeper's SDK is the strongest direct dependency candidate for a local personal-messaging prototype; a dedicated email adapter remains the clearest first hosted-channel test.
6. Keep the main UI to Inbox, Rooms and a clear audience-aware composer. Technical receipts, synchronization health and permissions should appear when relevant, not as permanent interface clutter.

## Source notes

All web sources were reviewed on September 8, 2026. Undated documentation describes the page at review time and may differ from released or account-enabled behavior. Product claims were not independently performance-tested. References below are grouped for retrieval; citations in the text identify the relevant evidence. Recommendations and architecture are our synthesis.

### Multiplayer products

[P1] YC Software. QM repository and README. Current branch. [Source](https://github.com/yc-software/qm).

[P2] YC Software. QM Security Policy. Current branch. Experimental internal-organization assumptions and authority restrictions. [Source](https://github.com/yc-software/qm/blob/main/SECURITY.md).

[P3] Nathan Sobo. Introducing Delta. Zed, August 12, 2026. [Source](https://zed.dev/blog/introducing-delta).

[P4] Nathan Sobo. Software Is Made Between Commits. Zed, June 11, 2026. [Source](https://zed.dev/blog/introducing-deltadb).

[P5] Amp. Multiplayer documentation. Current page. [Source](https://ampcode.com/docs/orbs/multiplayer).

[P6] Amp. Agent to Agent documentation. Current page. [Source](https://ampcode.com/docs/orbs/agent-to-agent).

[P7] Slack. Build with AI as a team using Slack Code. Current help, checked against the August 20, 2026 launch announcement. [Help](https://slack.com/help/articles/54310833022355-Build-with-AI-as-a-team-using-Slack-Code). [Announcement](https://slack.com/blog/news/slack-code-channels-for-agents).

[P8] Kandev. Coordinate Work and Agent Communication. Current documentation. [Coordination](https://kandev.ai/docs/coordination). [Communication](https://kandev.ai/docs/agent-communication).

[P9] Kandev. Security and Trust. Current documentation. [Source](https://kandev.ai/docs/security).

[P10] Kandev. Feature Status. Current documentation, not a release guarantee. [Source](https://kandev.ai/docs/feature-status).

[P11] Vince Lwt. Patchwork repository and implementation plan. Experimental status. [Repository](https://github.com/vincelwt/patchwork). [Plan](https://github.com/vincelwt/patchwork/blob/main/IMPLEMENTATION_PLAN.md).

[P12] Collivo. Product and AI Governance and Control. Beta product documentation. [Product](https://www.collivo.com/). [Governance](https://www.collivo.com/features/ai-governance).

[P13] Agentic Workspaces. Agentic Workspace specification and Workspace Topic API RFC. Draft, 2026. [Repository](https://github.com/agentic-workspaces/agentic-workspace). [RFC](https://github.com/agentic-workspaces/agentic-workspace/blob/main/rfcs/0001-workspace-topic-api-surface.md).

[P14] Sawmonabo. AI Sidekicks repository and cross-plan dependencies. Current implementation status. [Repository](https://github.com/Sawmonabo/ai-sidekicks). [Status](https://github.com/Sawmonabo/ai-sidekicks/blob/main/docs/architecture/cross-plan-dependencies.md).

### Engineering essays

[E1] Birgitta Böckeler. Harness engineering for coding agent users. April 2, 2026. Expert synthesis. [Source](https://martinfowler.com/articles/harness-engineering.html).

[E2] Lance Martin, Gabe Cemaj and Michael Cohen. Scaling Managed Agents Decoupling the brain from the hands. Anthropic, April 8, 2026. Primary engineering account. [Source](https://www.anthropic.com/engineering/managed-agents).

[E3] Rahul Garg. The Orchestrator's Tax. July 16, 2026. Exploratory case, not controlled cost evidence. [Source](https://www.martinfowler.com/articles/orchestrator-tax.html).

### Academic literature

[A1] Carl Gutwin and Saul Greenberg. A Descriptive Framework of Workspace Awareness for Real-Time Groupware. Computer Supported Cooperative Work 11, 411–446, 2002. [Paper](https://grouplab.cpsc.ucalgary.ca/grouplab/uploads/Publications/Publications/2002-DescriptiveFramework.JCSCW.pdf).

[A2] Herbert H. Clark and Susan E. Brennan. Grounding in Communication. Perspectives on Socially Shared Cognition, 127–149, 1991. [Chapter](https://web.stanford.edu/~clark/1990s/Clark,%20H.H.%20_%20Brennan,%20S.E.%20_Grounding%20in%20communication_%201991.pdf).

[A3] Eric Horvitz. Principles of Mixed-Initiative User Interfaces. CHI 1999, 159–166. [Paper](https://erichorvitz.com/chi99horvitz.pdf).

[A4] Saleema Amershi and colleagues. Guidelines for Human-AI Interaction. CHI 2019, Paper 3. [Publication](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/).

[A5] Michelle Vaccaro, Abdullah Almaatouq and Thomas Malone. When combinations of humans and AI are useful A systematic review and meta-analysis. Nature Human Behaviour 8, 2293–2303, 2024. [Article](https://www.nature.com/articles/s41562-024-02024-1). [PDF](https://www.nature.com/articles/s41562-024-02024-1.pdf).

[A6] Shamsi T. Iqbal and Eric Horvitz. Disruption and Recovery of Computing Tasks Field Study Analysis and Directions. CHI 2007. [Paper](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/11/CHI_2007_Iqbal_Horvitz-1.pdf).

[A7] Helen Nissenbaum. Privacy as Contextual Integrity. Washington Law Review 79, 119, 2004. Publisher abstract and record reviewed; full text unavailable. [Record](https://digitalcommons.law.uw.edu/wlr/vol79/iss1/10/).

[A8] Mert Cemri and colleagues. Why Do Multi-Agent LLM Systems Fail. NeurIPS 2025 Datasets and Benchmarks. Updated version reviewed. [Proceedings](https://proceedings.neurips.cc/paper_files/paper/2025/hash/b1041e52d3be19f0a9bc491657488e4a-Abstract-Datasets_and_Benchmarks_Track.html). [Paper](https://arxiv.org/html/2503.13657v3).

[A9] Yubin Kim and colleagues. Towards a Science of Scaling Agent Systems. arXiv 2512.08296, 2025, version 2. Preprint; revised manuscript under review according to authors. [Paper](https://arxiv.org/html/2512.08296v2). [Status](https://github.com/ybkim95/agent-scaling/).

### Unified inboxes and local bridges

[F1] Front. Channels Overview. Application Channels preferred to legacy Custom Channels. [Source](https://dev.frontapp.com/docs/channels-overview).

[F2] Front. How to delegate your inbox to a teammate. Edited July 21, 2026. [Source](https://help.front.com/en/articles/2143).

[F3] Missive. Features. Current product documentation. [Source](https://missiveapp.com/features).

[F4] Front. Real-time collision detection. Current help. [Source](https://help.front.com/en/articles/2403).

[F5] Chatwoot. What is a channel What is an inbox. April 29, 2026. [Source](https://www.chatwoot.com/hc/user-guide/articles/1677492191-adding-inboxes).

[F6] Chatwoot. Agent Bots Bring Your Own AI Agent and API introduction. [Bots](https://www.chatwoot.com/features/chatbots). [API](https://developers.chatwoot.com/api-reference/introduction).

[B1] Beeper. Desktop API. Local operation, personal-use recommendation, history and operating-system limits. [Source](https://developers.beeper.com/desktop-api/).

[B2] Beeper. Desktop API Authentication. Tokens and OAuth with PKCE. [Source](https://developers.beeper.com/desktop-api/auth/).

[B3] Beeper. Desktop MCP and message sending reference. [MCP](https://developers.beeper.com/desktop-api/mcp/). [Send](https://developers.beeper.com/desktop-api-reference/resources/messages/methods/send/).

### Channel provider documentation

[C1] Google. Choose Gmail API scopes. Updated July 22, 2026. [Source](https://developers.google.com/workspace/gmail/api/auth/scopes).

[C2] Google. Configure push notifications in Gmail API. Updated July 22, 2026. [Source](https://developers.google.com/workspace/gmail/api/guides/push).

[C3] Google. Synchronize clients with Gmail. Updated July 22, 2026. [Source](https://developers.google.com/workspace/gmail/api/guides/sync).

[C4] Microsoft. User sendMail. Graph v1.0. [Source](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0).

[C5] Microsoft. Receive change notifications through webhooks. [Source](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks).

[C6] Microsoft. Get incremental changes to messages in a folder. [Source](https://learn.microsoft.com/en-us/graph/delta-query-messages).

[C7] WhatsApp. Business Messaging Policy. Current effective policy reviewed. [Source](https://whatsappbusiness.com/policy/).

[C8] WhatsApp. Business Solution Terms. Published page marked March 6, 2026; includes AI-provider and country-code provisions. [Source](https://www.whatsapp.com/legal/business-solution-terms?lang=en).

[C9] Telegram. Bots FAQ. Current official documentation. [Source](https://core.telegram.org/bots/faq).

[C10] Telegram. Connected business bots. Current rights, recipient selection and connection limits. [Source](https://core.telegram.org/api/bots/connected-business-bots).

[C11] AsamK. signal-cli repository. Unofficial integration, not Signal's service API. [Source](https://github.com/AsamK/signal-cli).

[C12] Signal. Linked Devices. Official support. [Source](https://support.signal.org/hc/en-us/articles/360007320551-Linked-Devices).

[C13] Twilio. Outbound Message Status in Status Callbacks. [Source](https://www.twilio.com/docs/messaging/guides/outbound-message-status-in-status-callbacks).

[C14] Twilio. Customize users opt-in and opt-out experience with Advanced Opt-Out. [Source](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out).

[C15] WhatsApp. Meta Terms for WhatsApp Business. Published notice of September 23, 2026 changes; do not treat the future terms as already effective. [Source](https://www.whatsapp.com/legal/meta-terms-whatsapp-business?lang=fa).

[C16] Google. Workspace API user data and developer policy and policy protections for generative AI. [Policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy?hl=en). [Explanation](https://workspace.google.com/blog/ai-and-machine-learning/api-policy-protections).

### Local project evidence

[L1] Project Room. Current handoff and Help Offer Storage Checkpoint, September 8, 2026. Runtime3984941 and schema14; previous recorded test counts, pending human controls and recovery gates. Local files PROJECT-ROOM-CURRENT.md and ../docs/HELP-OFFER-STORAGE-CHECKPOINT-2026-09-08.md. No private credentials or provider messages included in this report.

[L2] Project Room. Inspected source boundaries in server/http.mjs, client/room-agent.mjs and src/events.js under the same local worktree. Read-only architecture inspection, not a new full-code audit.

### Pinned implementation sources

[K1] QM, revision 60ba79195dc84aa85a23f238749656e11c88696c. [Ingress](https://github.com/yc-software/qm/blob/60ba79195dc84aa85a23f238749656e11c88696c/src/slack/turn-handler.ts). [Admission](https://github.com/yc-software/qm/blob/60ba79195dc84aa85a23f238749656e11c88696c/src/api/app-turn.ts). [Run storage](https://github.com/yc-software/qm/blob/60ba79195dc84aa85a23f238749656e11c88696c/src/runs/postgres-run-store.ts). [Worker](https://github.com/yc-software/qm/blob/60ba79195dc84aa85a23f238749656e11c88696c/src/runs/worker.ts).

[K2] QM, same revision. [Harness interface](https://github.com/yc-software/qm/blob/60ba79195dc84aa85a23f238749656e11c88696c/src/harness/harness.ts). [Capability gate](https://github.com/yc-software/qm/blob/60ba79195dc84aa85a23f238749656e11c88696c/src/api/server.ts). [Scope resolution](https://github.com/yc-software/qm/blob/60ba79195dc84aa85a23f238749656e11c88696c/src/resolution/resolution-service.ts). [Orchestrator](https://github.com/yc-software/qm/blob/60ba79195dc84aa85a23f238749656e11c88696c/src/core/orchestrator.ts).

[K3] QM, same revision. [Slack delivery](https://github.com/yc-software/qm/blob/60ba79195dc84aa85a23f238749656e11c88696c/src/slack/delivery.ts). [Delivery tests](https://github.com/yc-software/qm/blob/60ba79195dc84aa85a23f238749656e11c88696c/test/slack-delivery.test.ts). [Run-store tests](https://github.com/yc-software/qm/blob/60ba79195dc84aa85a23f238749656e11c88696c/test/run-store.test.ts). [Redelivery tests](https://github.com/yc-software/qm/blob/60ba79195dc84aa85a23f238749656e11c88696c/test/slack-redelivery-dedup.test.ts).

[K4] Agentic Workspace, revision 53754b357531fdd675859890dfbf416c7b4ac906. [Manager](https://github.com/agentic-workspaces/agentic-workspace/blob/53754b357531fdd675859890dfbf416c7b4ac906/reference-impl/wsmanager.ts). [Runtime](https://github.com/agentic-workspaces/agentic-workspace/blob/53754b357531fdd675859890dfbf416c7b4ac906/reference-impl/wmlet.ts). [Demo auth](https://github.com/agentic-workspaces/agentic-workspace/blob/53754b357531fdd675859890dfbf416c7b4ac906/reference-impl/auth.ts). [Unit assertions](https://github.com/agentic-workspaces/agentic-workspace/blob/53754b357531fdd675859890dfbf416c7b4ac906/reference-impl/tests/wmlet-unit.test.ts).

[K5] Chatwoot, revision b227f8042738a124fea7bf65ac413e4dc9c8196a. [Webhook job](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/app/jobs/webhooks/whatsapp_events_job.rb). [Incoming service](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/app/services/whatsapp/incoming_message_base_service.rb). [Deduplication lock](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/app/services/whatsapp/message_dedup_lock.rb).

[K6] Chatwoot, same revision. [Conversation finder](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/app/services/mailbox/conversation_finder.rb). [Reply mailbox](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/app/mailboxes/reply_mailbox.rb). [Mailbox helper](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/app/mailboxes/mailbox_helper.rb).

[K7] Chatwoot, same revision. [Channel delivery guard](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/app/services/base/send_on_channel_service.rb). [Webhook predicate](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/app/models/concerns/message_filter_helpers.rb). [Bot listener](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/app/listeners/agent_bot_listener.rb).

[K8] Chatwoot, same revision. [Composer](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/app/javascript/dashboard/components/widgets/conversation/ReplyBox.vue). [Handoff model](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/app/models/conversation.rb). [Message callbacks](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/app/models/message.rb). [Status rules](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/app/services/messages/status_update_service.rb).

[K9] Chatwoot, same revision. [Incoming tests](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/spec/services/whatsapp/incoming_message_service_spec.rb). [Status tests](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/spec/services/messages/status_update_service_spec.rb). [Handoff tests](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/spec/models/conversation_spec.rb). [Mailbox tests](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/spec/mailboxes/reply_mailbox_spec.rb).

[K10] Beeper Desktop API TypeScript SDK, revision c6aa0eb9287d8f0f13c4f661b5d24f07cd2a680a, release 5.0.0. [Message contract](https://github.com/beeper/desktop-api-js/blob/c6aa0eb9287d8f0f13c4f661b5d24f07cd2a680a/src/resources/messages.ts). [Message tests](https://github.com/beeper/desktop-api-js/blob/c6aa0eb9287d8f0f13c4f661b5d24f07cd2a680a/tests/api-resources/messages.test.ts).

[K11] Beeper SDK, same revision. [Client defaults, retry and idempotency handling](https://github.com/beeper/desktop-api-js/blob/c6aa0eb9287d8f0f13c4f661b5d24f07cd2a680a/src/client.ts).

[K12] Beeper SDK, same revision. [Generated MCP server](https://github.com/beeper/desktop-api-js/blob/c6aa0eb9287d8f0f13c4f661b5d24f07cd2a680a/packages/mcp-server/src/server.ts). [Method catalog](https://github.com/beeper/desktop-api-js/blob/c6aa0eb9287d8f0f13c4f661b5d24f07cd2a680a/packages/mcp-server/src/methods.ts).

[K13] Mautrix Go, revision 501dff1482808ea64ea581bbc174e6df9db3dd8d. [Portal and pending-message handling](https://github.com/mautrix/go/blob/501dff1482808ea64ea581bbc174e6df9db3dd8d/bridgev2/portal.go). [Message storage model](https://github.com/mautrix/go/blob/501dff1482808ea64ea581bbc174e6df9db3dd8d/bridgev2/database/message.go).

[K14] Mautrix WhatsApp, revision 82c79d1108e7c1badbcc9b2019cb560b6daaa7a2. [Outgoing conversion and send](https://github.com/mautrix/whatsapp/blob/82c79d1108e7c1badbcc9b2019cb560b6daaa7a2/pkg/connector/handlematrix.go). [Incoming events and receipts](https://github.com/mautrix/whatsapp/blob/82c79d1108e7c1badbcc9b2019cb560b6daaa7a2/pkg/connector/handlewhatsapp.go). [Capabilities](https://github.com/mautrix/whatsapp/blob/82c79d1108e7c1badbcc9b2019cb560b6daaa7a2/pkg/connector/capabilities.go).

[K15] Pinned license texts. [QM](https://github.com/yc-software/qm/blob/60ba79195dc84aa85a23f238749656e11c88696c/LICENSE). [Agentic Workspace](https://github.com/agentic-workspaces/agentic-workspace/blob/53754b357531fdd675859890dfbf416c7b4ac906/LICENSE). [Chatwoot](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/LICENSE). [Chatwoot enterprise](https://github.com/chatwoot/chatwoot/blob/b227f8042738a124fea7bf65ac413e4dc9c8196a/enterprise/LICENSE). [Beeper SDK](https://github.com/beeper/desktop-api-js/blob/c6aa0eb9287d8f0f13c4f661b5d24f07cd2a680a/LICENSE). [Mautrix Go](https://github.com/mautrix/go/blob/501dff1482808ea64ea581bbc174e6df9db3dd8d/LICENSE). [WhatsApp bridge](https://github.com/mautrix/whatsapp/blob/82c79d1108e7c1badbcc9b2019cb560b6daaa7a2/LICENSE).
