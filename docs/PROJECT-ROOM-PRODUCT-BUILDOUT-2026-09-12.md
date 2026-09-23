# Project Room product buildout plan

## 1. Product direction

Build the place a small team chooses to keep open because its people, agents, conversations, and useful work are together. It should feel as approachable as a group chat, as responsive as a polished creative tool, and as trustworthy as a serious business system. Enterprise capability should deepen control without burdening the everyday interface.

The initial audience is **small teams already using AI agents**: product studios, founder teams, independent research groups, agencies, and open-source maintainers. Start with teams of roughly 3–15 people as a recruitment hypothesis, not a market-size estimate. These teams have immediate coordination pain, can adopt one room without a company-wide migration, and can bring customers or collaborators into a useful experience.

The differentiating promise is not simply “Slack with agents.” It is **shared context, clear responsibility, and useful results that survive the conversation**. People should be able to ask, discuss, contribute, review, and return without copying the same background into several disconnected tools. Agents should participate through interchangeable, permissioned connections—not masquerade as people or operate through the owner's unrestricted identity.

Suggested positioning to test: **“Your team. Your agents. One room.”** Supporting sentence when needed: **“Talk, make things, and keep the useful parts.”** These are proposed messages, not claims that every planned capability is available today.

The product must still be enjoyable without a task, agent, or deliverable. Casual conversation, sharing references, celebrating a result, and spending time together are legitimate uses. The goal is more voluntary, valuable time together—not more compulsory checking, notification anxiety, or agent-generated volume.

### Strategic choices

1. **Win a project before replacing an organization.** Let one team use Project Room alongside existing tools, then earn expansion.
2. **Keep chat as home.** Work and results open in context; an administrative dashboard is not the default experience.
3. **Make agents accountable participants.** Identify their operator, permissions, current assignment, connection health, and result provenance when relevant.
4. **Make leaving and returning easy.** Search, a useful catch-up, stable links, export, and preserved drafts are retention features.
5. **Earn public growth after trust gates.** Discovery can be public while room contents, membership, and execution remain private.
6. **Build one product, not two skins over different systems.** Consumer and enterprise experiences share objects and interaction patterns; policy and optional capabilities vary.
7. **Remove complexity at its source.** Fewer labels cannot compensate for duplicated permissions, contradictory statuses, or several ways to perform the same operation.

### What this plan does not promise

This is a buildout strategy, not a claim of current enterprise readiness, a deployment authorization, a fixed staffing commitment, or a legal compliance opinion. Research reflects official pages reviewed on September 12, 2026, with older foundational sources identified below. Vendor documentation establishes described capabilities, not comparative product quality or independently measured retention.

No live adoption dataset or validated retention baseline was available for this plan. Feature effects, segment fit, pricing, and schedules are hypotheses to test. No amount of AEO can guarantee a ranking, citation, recommendation, or agent adoption.

## 2. Grounding in the current product

Preserve the existing conversation-first direction and its versioned work/review model. The repository already contains chat, threads, reactions, scoped search, managed agent enrollment, portable agent context, work sessions, source-linked results, account/invitation machinery, and catch-up surfaces. Existing quiet-interface work has already reduced success toasts, grouped consecutive messages, hidden secondary controls, and preserved agent identity. Do not rebuild these features under new names.

The September 8 blueprint remains valuable background, but its schema/version statements are historical. The newer chat-first decisions take precedence for the proposed default landing experience. This plan refines and sequences the product ambition; implementation contracts and exact-version verification still govern engineering changes.

The three September 12 audit documents establish serious gaps on frozen committed code and distinguish them from local prototype work:

| Foundation | Evidence-backed gap | Product consequence | Required response |
| --- | --- | --- | --- |
| Authentication | Thread route bypasses shared credential-mode/rate checks | Inconsistent privacy and abuse boundaries | One authorization boundary across every read alias |
| Agent authority | Narrow relink can restore broader old permissions | Reconnecting an agent may expand access unexpectedly | Recompute effective grants; revocation/relink regressions |
| Session control | Generic commands bypass dedicated worker/concurrency/budget checks | UI controls do not represent enforceable policy | Central live mutation policy; negative and positive endpoint tests |
| Provenance | Caller can forge budget-enforcement metadata | Audit facts can be mistaken for server enforcement | Separate caller reports from service-authored facts |
| Recovery | Invitation-bearing import and cleanup-capacity mismatch | A backup may not restore safely | Tested authority-aware recovery, not merely successful export |
| Diagnostics | Unbounded identifiers and insufficient path redaction | Capacity and privacy risk | Bounded storage and known route templates |
| Status | Inferred Online and premature Done | People cannot trust the interface | Evidence-derived state and explicit uncertainty |
| Release identity | Dirty bytes can be labeled as a clean revision | A passing test receipt may describe other code | Exact artifact hashes and reproducible release manifests |
| Public agent entry | MCP preview initially implied a successful join without persistence | Agents can loop or misunderstand availability | Honest unavailable state and conformance checks |

Grok's local preview has an independently checked 10-test improvement, but is not a deployed or fully qualified service. Additional protocol research found that the pinned MCP 2025-11-25 transport requires invalid present Origin to receive 403; the reviewed prototype test expected 400. That mismatch, all-method Origin handling, and residual input-shape checks must be reconciled before any conformance claim.[^19]

Current source also contains a `noindex,nofollow` public door and mixed Project Room/Demigod/Dasha routing. This was a deliberate pilot constraint, not a mistake to remove blindly. Public acquisition now needs a proposed canonical identity and a separate launch gate.

Internal evidence: [first audit](PROJECT-ROOM-AUDIT-2026-09-12.md), [second pass](PROJECT-ROOM-SECOND-PASS-2026-09-12.md), [third-pass checkpoint](PROJECT-ROOM-THIRD-PASS-2026-09-12.md), [reproducible boundary observations](audit-evidence-2026-09-12/boundary-results.json), [quiet interface](QUIET-FAST.md), [prior growth plan](GROWTH-PLAN.md), [earlier blueprint](../research/PROJECT-ROOM-BLUEPRINT.md).

## 3. Competitive landscape: what to learn, not what to copy

The following are source-backed capability observations followed by Project Room design judgments. They are not rankings. Pricing, performance, market share, and feature availability by account were not independently benchmarked.

| Reference | Observed capability | Implication for Project Room | What not to import |
| --- | --- | --- | --- |
| Slack | Channels, external collaboration, huddles, files, lists, canvases, search, and AI are integrated into its work surface.[^1] | Basic collaboration parity matters. Shared agent context must produce a visibly better project outcome, not another chat tab. | A broad navigation catalog before the small-team loop works |
| Discord | Community onboarding lets people select roles/channels and adjust them later; its documentation explicitly addresses overwhelming channel lists.[^2] | Start with one relevant room and an immediate social reason to participate. Reveal community breadth on demand. | A server setup wizard or dozens of empty channels |
| Teams | Microsoft documents group-chat Copilot participation as public preview, with answers grounded in the prompting person's accessible data.[^3] | Shared AI is already competitive territory. Make audience-safe context and BYO-agent continuity explicit advantages. | An assumption that a user's private retrieval results are safe to post to everyone |
| Zulip | Named topics organize parallel conversations and support asynchronous return.[^4] | Let substantive discussions acquire a short title and a full-width view. Promote structure when useful. | Requiring a subject line for every casual utterance |
| Linear | Agent sessions expose states including awaiting input and stale, plus links to external sessions.[^5] | Treat an agent run as a lifecycle with recovery and next actions. Separate connection health from task progress. | Making every human conversation an issue |
| Notion | Custom Agents have their own resource permissions and separate permissions controlling who can use/edit them.[^6] | Model “who may ask the agent” separately from “what the agent may access.” Review output audience as a third boundary. | Workspace-wide default context or an automation builder on first use |
| Basecamp | Hill Charts distinguish figuring out an approach from executing it.[^7] | Show meaningful phase and uncertainty instead of fabricated completion percentages. | Another project-status dashboard competing with the room |
| Discourse | Solved topics preserve accepted answers in the discussion.[^8] | A useful answer should become findable knowledge without losing its source conversation. | Popularity as a substitute for evidence or an authorized decision |
| Element | Offers enterprise collaboration with hosting control, encryption, and administrative capabilities.[^9] | Data ownership, portability, and deployment preferences are real buyer concerns. Document boundaries honestly. | Immediate federation/self-hosting commitments the team cannot operate |
| Signal | Separates identity discovery/privacy choices and supports revocable group links with optional admin approval.[^10] | Invitation convenience and control can coexist. Do not require public profiles for private participation. | Claims of Signal-equivalent encryption or metadata privacy without the architecture |

### Competitive conclusion

Project Room should not compete on number of integrations, number of AI models, or breadth of admin screens. Its initial comparative test should be concrete: **can a small team produce and review something together with less context copying and fewer lost handoffs?**

Useful early switching scenarios include a studio reviewing a prototype with a client, a research team comparing sources with two agents, or maintainers coordinating an issue and a reviewed patch. Each combines social discussion, agent contribution, and an outcome that must remain understandable later.

There are also reasons not to switch yet. Teams that need mature enterprise provisioning, large voice communities, complete mobile parity, or extensive regulated workflows may be better served by established systems until Project Room qualifies those capabilities. Honest comparison pages should say so.

## 4. Creative comparative research

Cross-category inspiration is a source of testable ideas, not proof of causality. The product should borrow a useful interaction principle while leaving behind the unrelated business model or infrastructure.

### 4.1 Spotify Jam: a shared queue with a host

Spotify Jam lets participants contribute to a shared queue and gives the host participation controls; remote participation has plan constraints.[^11] The transferable idea is shared momentum around an object everyone understands.

**Experiment:** a room review session with a short queue of artifacts. Participants can add an item, ask a question, or mark it reviewed; a host moves the group forward. Agents may prepare evidence but cannot flood the queue. Begin with an ordered list of existing artifacts, not synchronized media infrastructure.

### 4.2 Partiful: invite someone to a reason

Partiful illustrates event-centered invitations and adjustable guest access. Its marketing says browser RSVP can avoid accounts, while its help documentation says email-invited guests still log in with a phone number; that inconsistency means frictionless RSVP must not be treated as universally verified.[^12]

**Experiment:** invitations say “Review our prototype” or “Join Thursday's build session,” show the host and permitted destination, and land on the relevant object. The lesson is purpose-first entry, not a promise of accountless access for confidential work. Do not collect contacts or send invitations automatically.

### 4.3 Are.na: the collection becomes the memory

Are.na describes interconnected collections, search, and an open API without personalized recommendations.[^13] The useful principle is intentional accumulation rather than a feed optimized for endless consumption.

**Experiment:** a room shelf containing its brief, references, decisions, and selected results. Show why an item matters and where it was used. Reuse existing records and permission checks. Avoid a parallel knowledge database that needs its own maintenance.

### 4.4 Figma: share attention without taking control

Figma's spotlight/follow behavior lets permitted collaborators view the same area of a file.[^14] Presence becomes useful when it indicates the object under discussion.

**Experiment:** “Follow” opens the artifact or section someone is showing, with immediate escape and no permission expansion. Start with object links and anchored sections. Do not introduce background screen capture, cursor surveillance, or automatic remote control.

### 4.5 Raycast: a coherent action language

Raycast's Action Panel groups object actions and exposes keyboard shortcuts.[^15] The transferable idea is a consistent place to find the next useful operation.

**Experiment:** one contextual action menu across messages, artifacts, work, and members. Common actions remain visible; the menu holds depth. The same authorized operation backs pointer, keyboard, and agent interfaces, with confirmation appropriate to each audience.

### 4.6 Museum interpretation: let the object do the talking

The V&A's gallery-text guidance emphasizes hierarchy, understandable language, and text fitted to people encountering objects in a busy environment.[^16] A software screen similarly competes with the thing the person came to see.

**Experiment:** strip explanatory prose from a result card and let the title, preview, status, and next action carry it. Move context to a short expandable note. Keep labels where omission creates ambiguity. This is a method for reducing cognitive effort, not a museum word-count rule applied to software.

### 4.7 Nintendo Miiverse: acknowledgment as empathy

Nintendo's historical Miiverse producer interviews discuss empathy and its lightweight acknowledgment interaction.[^17] This is historical inspiration, not evidence that the discontinued product's mechanics improve today's retention.

**Experiment:** make small supportive reactions easy and culturally expressive. Let a team choose a small reaction vocabulary; hide unused reaction controls until needed. Avoid turning appreciation into rankings, compulsory streaks, or agent-generated praise.

### 4.8 GitHub review: agreement attaches to a version

GitHub documents required review and options to invalidate stale approvals when changes arrive.[^18] The useful pattern is that acceptance should describe the thing reviewed, not a moving object.

**Refinement:** retain Project Room's exact-version review model. Show “Changed since review” when needed. Let people compare two results and choose one without erasing the other. Ordinary social approval reactions must never become formal authorization.

### 4.9 Non-software analogies to test

These are original design analogies, not sourced claims about industry outcomes:

- **A workshop bench:** tools stay nearby, the object occupies the center, and unfinished work remains where the team left it. Apply this to persistent artifact detail and restored reading position.
- **A relay handoff:** the next participant needs a clear object, current state, and responsibility transfer. Apply this to agent handoffs with accepted scope and one current writer.
- **A library desk:** a short answer points to inspectable material. Apply this to source-linked catch-up and answer provenance.
- **A dinner table:** people can participate casually without declaring a project. Apply this to social chat that never demands task conversion.
- **A rehearsal room:** a group can try another version without replacing the selected result. Apply this to bounded alternatives and review sessions.

Each analogy should become a small prototype and a real task test. If it adds a new top-level noun without making the task easier, discard it.

## 5. A simpler product model

### Visible vocabulary

The everyday product needs only a few concepts:

- **Room:** the people, conversation, and shared material for a purpose.
- **Thread:** a conversation within the room.
- **Work:** a deliberate request with responsibility and an expected result.
- **Result:** a versioned output someone can inspect and use.
- **People and agents:** participants, with differences disclosed where they matter.

“Session,” “claim,” “projection,” “capability,” “authorization epoch,” and transport names belong in developer documentation or advanced details, not casual navigation. A run can be displayed as an attempt within work without creating a mandatory Runs destination.

### Information architecture

At launch, use a stable room switcher, a personal **Needs you** entry, search, and account controls. Open the last accessible room by default, restoring the relevant position. A direct invitation or artifact link overrides that default and preserves its destination through sign-in.

Inside a room, conversation dominates. Work and saved results are alternate views or contextual panels, not equal-sized dashboards shown simultaneously. Desktop may show a selected thread/result beside chat; mobile opens it full-screen with a predictable back action and preserved draft.

Needs you unifies mentions, explicit questions, invitations, review requests, and failures that require this person. It is not the account's private external-mail Inbox. Do not merge private email into shared attention simply because both use the word inbox. External messaging remains a separately qualified capability.

### Enterprise depth

Organization administration belongs outside the conversation surface. Members should not see controls they cannot use. Owners should see an invite action and a predictable settings location—not a constant security questionnaire. Sensitive actions still show audience, permissions, cost, and reversibility at the moment of choice.

## 6. UI/UX design specification

### Visual character

Aim for calm, crisp, warm restraint. Use a neutral base, one restrained accent, consistent spacing, readable typography, and clear grouping. Identity and content provide the color. Avoid decorative gradients, several nested cards, oversized greetings, crowded pill rows, and dashboard-style metrics in chat.

Prototype a 4/8-based spacing system, comfortable reading width, two message densities, and light/dark themes. These are starting design choices to validate, not accessibility standards. Keep persistent controls stable when content updates. Reserve motion for continuity and feedback; honor reduced motion.

### The first minute

An invited participant should see the room name, who invited them, what they can do, and one clear entry action. After entry, show the actual conversation or requested artifact. Do not force them to name a workspace, connect an agent, complete a profile, choose a template, and invite someone before participating.

For a creator, ask for a room name and make privacy clear. Offer an optional short purpose, but do not require a mission statement. After creation, the composer is ready. Invite and Add agent are available when useful; neither is compulsory. A demonstration room must be unmistakably separate from live user content.

Guest access needs an honest expiration and a safe return path. Before expiry, offer to retain access through a normal account without silently widening room permission. Replace key-paste onboarding for ordinary humans with a qualified sign-in/invitation experience; preserve keys in developer and operator tools.

### Conversation quality

Preserve grouped messages, timestamps on demand, thread counts, mention selection, unread markers, and stable scroll. Add or qualify editing, deletion, attachments, link previews, paste behavior, code blocks, and failed-send recovery before cosmetic novelty. Pending messages need a subtle state; failed messages need an explicit Retry action and a preserved draft.

Do not display the full agent execution log as chat. One compact progress item may update in place, with details on demand and a final result. Participants can expand the history without making every person receive dozens of incremental updates.

Incoming messages must not move someone reading older content. Keyboard mention selection must survive rerenders, composition input must not accidentally send, and browser back must restore the prior view. Touch users need explicit access to controls hidden on desktop hover.

### Agent onboarding

Lead with **Add agent**, then an understandable choice: connect an agent the person already uses or use a portable brief. Detect a supported connection route when reliable, but keep it changeable. Do not present Packet/MCP/Node as three unexplained primary choices to a nontechnical person.

Show only what is true: Connected, Not connected, Needs access, or Connection unknown. Running is task state, not proof of network presence. Show who manages an agent and the relevant data scope before connecting it. A known brand preset is not proof that the actual agent is authenticated or compatible.

Addressing, granting access, assigning work, and starting external execution are separate operations. A configured agent may respond to an explicit mention under its approved policy; merely browsing the room or adding a name must not silently start billable work. Provide a short, specific unavailable state rather than instructions that send users in circles.

### Results and review

Open the result itself first: document, image, patch, comparison, or safe interactive preview. Put the agent's narration below or in details. Keep source, version, author, review state, and meaningful limitations close enough to inspect.

For reviewable work, use **Review** to enter the decision and **Accept** or **Request changes** for the actual choice. Distinguish “agent finished” from “accepted.” If no review is required, use the existing policy to derive completion; do not force enterprise-style approval onto casual work.

### Accessibility and device quality

Target WCAG 2.2 AA and verify it with keyboard, screen-reader, zoom, contrast, and real-device tests—not only an automated score.[^25] Prefer generous touch targets; treat 44 CSS pixels as a design preference where practical, not a claim that every AA target must be that size. Preserve visible focus, accessible names, semantic regions, error association, and status announcements that do not repeatedly read the whole chat.

Test a narrow phone viewport with the keyboard open, 200% and 400% zoom/reflow, long names, long translations, right-to-left layouts, slow networks, reconnect, and account switching. A beautiful desktop screenshot is not a release gate.

For public pages, use the published Core Web Vitals good thresholds at the 75th percentile: LCP at most 2.5 seconds, INP at most 200 milliseconds, and CLS at most 0.1, separately for mobile and desktop.[^26] For authenticated app operations, define separate measured service and interaction budgets; do not treat page-load metrics as message-delivery guarantees.

## 7. Copy: remove before rewriting

### The decision sequence

For every visible string, ask in this order:

1. Does the object, layout, or state already explain this?
2. Can the control or workflow disappear because a safe default handles it?
3. Is a label necessary to identify an action or consequence?
4. Can the explanation move to the moment it matters?
5. If words remain, what is the shortest accurate wording?

Do not optimize a word-count score at the expense of comprehension. Progressive disclosure needs discoverable, well-labeled entry points; unfamiliar icons alone often create ambiguity.[^27] Public documentation can be detailed even when in-product copy is sparse. AEO does not require stuffing the application interface with explanatory text.

### Proposed copy inventory

These are candidate replacements. Existing examples come from current source/prior interface documents where indicated; others describe planned states.

| Surface | Remove or refine | Proposed visible treatment | What must remain available |
| --- | --- | --- | --- |
| Welcome | Repeated product explanation after entry | Nothing; show the room | First-use help on request |
| Composer | Long instructions about room visibility and addressing | “Message…” | Accessible label; contextual audience when it changes |
| Ordinary send | “Message saved to the room” | No success toast | Pending/failure state and Retry |
| Reaction | “Reaction saved” | Updated reaction | Accessible feedback without noisy repetition |
| Addressing | Repeated “Talking to” toolbar prose | Recipient chip only when selected | Remove/change recipient action |
| Work card | Repeated field explanations and raw IDs | Title, truthful state, next action | Details with criteria, ownership, version, evidence |
| Owner field | “Accountable” for ordinary users | “Owner” | Exact role explanation in settings/docs |
| Result | Long agent completion preamble | Artifact preview first | Limits, evidence, review state |
| Connection | “Create access” without context | “Connect” within Add agent | Scope and approval before credential creation |
| Not connected | A long setup paragraph in chat | “Not connected” · “Connect” | Technical troubleshooting in details |
| Agent has finished | Generic “Done” despite required review | “Ready for review” | Which result/version is ready |
| Stop requested | Immediate “Stopped” | “Stopping…” until confirmed | Timeout/failure and external-runner limitation |
| Public MCP preview | Instructions to keep joining/listening | “Preview only. Joining is unavailable.” | Machine-readable unavailable result, no retry loop |
| Empty search | Apology and generic explanation | “No results” · “Clear filters” | Search scope and spelling/filter options |
| Expired invitation | Ambiguous access-denied paragraph | “Invite expired” · “Ask for a new link” | No disclosure of private room contents |
| Revocation | “Something went wrong” | “Access removed” | Safe destination and account-switch option |
| Public sharing | Icon-only publish control | “Publish” with explicit audience confirmation | Indexability, included content, revocation limits |
| External action | Vague “Continue” | Name the action: “Send email,” “Run,” or “Delete” | Recipient, destination, cost, irreversibility |

### Copy standards

Prefer short verbs and concrete nouns. Avoid “seamless,” “unlock,” “leverage,” “AI-powered” on every surface, “successfully,” and repeated greetings. Do not rename a familiar action merely to sound distinctive. Use sentence case and stable terminology.

Keep privacy, consent, error recovery, and cost information. A two-line accurate warning is better than an elegant but misleading button. Destructive or external actions should say what will happen; confirmation text must not make a consequential action look routine.

Maintain a string inventory with surface, purpose, owner, audience, translation key, and a remove/retain/refine decision. Each UI pull request should justify new persistent text. A lightweight review can flag duplicated labels and stale capability claims without enforcing arbitrary hard word limits.

## 8. Feature portfolio

### Build or refine first

| Initiative | User value | Smallest useful version | Acceptance evidence | Boundary |
| --- | --- | --- | --- | --- |
| Reliable join and return | Friends/colleagues can actually stay | One invitation journey with recoverable identity | Join, close, return, expire, revoke, switch accounts | No permission expansion on recovery |
| Calm conversation | Pleasant everyday use | Stable scroll, drafts, retries, keyboard/touch parity | Real send/reply/search journeys | No message-volume objective |
| Agent connection card | Know whether help is available | Operator, scope, connection state, one next action | Two independently qualified connection routes | No fake presence |
| Work handoff | Reduce duplicated context and collisions | Versioned brief, current owner, accepted scope | Two agents hand off without overlapping writes | Delegation cannot expand authority |
| Result review | Understand and select the useful output | Preview, evidence, exact-version acceptance | Changed result invalidates relevant review | Reactions are not approvals |
| Needs you | Find the few things requiring action | Mentions, questions, reviews, actionable failures | Correct audience, clear/unread semantics | No mandatory inbox clearing |
| Room shelf | Keep useful knowledge accessible | Save existing brief/decision/result/reference | Open source and current version from shelf | No copied private history |
| Purposeful invite | Give a collaborator a reason to join | Invite to an artifact or thread | Destination survives sign-in; revocation works | No automatic invitations |

### Differentiate after the foundation

**Context handoff.** Show the compact material an agent will receive: selected conversation, brief, accepted decisions, and relevant artifact versions. Let a person remove material before sharing. When the brief changes, show that the running attempt has older context rather than silently pretending it updated.

**Compare results.** Put alternatives beside the same criteria. Show meaningful differences, source quality, and unresolved questions. Keep the selected result and the decision rationale. Start with text and linked artifacts; do not build a general diff engine for every media format.

**Use again.** Turn a successful collaboration into a template containing steps, expected inputs, output shape, and permission requirements—not credentials, private messages, or copied access. The new room must explicitly bind its own sources and agents.

**Room review session.** A lightweight, time-bounded gathering around a few artifacts, with an optional agenda and a shared next item. Start asynchronously; add qualified audio later. Keep host control and an easy exit.

**Decision memory.** Distinguish accepted decisions from suggestions. Record owner, version, source, and last confirmation. If supporting material changes, flag the decision for review instead of silently rewriting institutional memory.

**Shared attention.** Follow a permitted artifact/section that a collaborator is showing. No whole-desktop access is needed for the first version. A small “showing this” indicator should be useful, optional, and ephemeral.

**Agent availability matching.** Within a room's approved roster, suggest an agent whose declared capabilities match a request. Explain the match briefly and let the person choose. Start with deterministic capabilities, not an opaque global ranking or marketplace.

### Consumer warmth, intentionally small

Offer optional room color/cover, custom emoji with moderation, lightweight polls, event prompts, and a small shared collection. A room should feel made by its members. None of these should require a public profile or expose organization membership.

Support personal identity continuity with room-specific display choices, clear impersonation handling, and blocked-user behavior. Treat direct/group private messages as a later parity feature with a real authorization and reporting design, not an accidental backdoor around room controls.

### Defer until evidence justifies them

Defer a public agent marketplace, payouts/bounties, a full email client, an infinite canvas, a general automation graph editor, federation, native video infrastructure, a global social feed, and agent leaderboards. They may be valuable later, but each introduces a substantial new operational or trust surface.

Do not replace all integrations with internal clones. First support links and deliberate imports. Add an adapter when repeated real use shows that the boundary—not product quality—is preventing value.

## 9. Enterprise architecture and operating readiness

### One canonical policy boundary

Keep the event-backed domain model and existing review semantics. Consolidate live command authorization, input validation, idempotency, session ownership, concurrency, and budget policy into shared application operations. HTTP, MCP, UI, keyboard shortcuts, and future integrations should call those operations rather than recreate their own rules.

Historical replay must not rerun today's live authorization; live submission must not be mistaken for trusted replay. Establish a clear boundary between user-provided reports and service-derived evidence. Preserve operation IDs and exact result versions across retries.

Avoid a microservice rewrite as an early response. First isolate modules, specify contracts, and measure resource limits. Storage partitioning, asynchronous queues, and separate search infrastructure should follow demonstrated capacity needs and tenant isolation requirements.

### Trust layers

| Area | Small-team production gate | Enterprise pilot extension | Later expansion |
| --- | --- | --- | --- |
| Identity | Recoverable human sign-in, short-lived sessions, safe invites | SSO, managed domains, provisioning/deprovisioning, emergency access | More identity providers and complex org structures |
| Permissions | Explicit room/agent scopes, immediate revocation | Groups, delegated admin, guest lifecycle, access review | Fine-grained custom policies where demanded |
| Agent execution | BYO connection honesty, bounded supported runs, clear operator | Approved providers/tools, egress policy, org budgets | Qualified hosted execution with contracts and support |
| Data lifecycle | Export/restore/delete verified; private by default | Retention policy, audit export, legal-hold design as required | Residency options, customer-managed keys where justified |
| Reliability | Measured service objectives, alerting, backups, restore drill | Incident process, support commitments, tenant-aware capacity | Multi-region or dedicated hosting after demand |
| Security assurance | Threat model, dependency review, vulnerability intake | Independent assessment and evidence-backed trust center | Formal certifications on their actual audit timeline |
| Administration | Simple settings and connection inventory | Admin console, policy change history, offboarding evidence | Advanced reporting without worker surveillance |

This is a readiness checklist, not a statement that any certification or legal requirement has been met. Procurement language must match qualified capabilities. Do not promise end-to-end encryption while a server-side agent/search service can access plaintext; choose and explain an architecture before making that claim.

### Agent-specific safety

Separate the person asking, the agent identity, the agent's data scope, its tools, and the output audience. A person able to talk to an agent must not automatically receive everything the agent can retrieve. Check access before retrieval, before committing an action, and before delivery into a room.

Untrusted messages, documents, web pages, tool output, and peer-agent claims remain data. They cannot grant rights, override room policy, or authorize outbound actions. Use scoped tools and explicit approval for sensitive operations; prompt warnings alone are not the boundary. OWASP identifies excessive functionality, permissions, and autonomy as central agency risks.[^28]

Every supported run needs a durable identity, scope, state, timeout/retry policy, and cancellation semantics. “Stop” must distinguish requested, acknowledged, and unable-to-confirm. If an external runner cannot enforce a hard budget, label the value as reported/estimated and avoid implying a guaranteed cap.

Memory is permissioned data, not hidden authority. Source links, freshness, and provenance must survive summarization. Revocation and deletion need to cover derived summaries, embeddings, exports, caches, and future retrieval, with disclosed backup handling. Do not promise that already exported material can be recalled from recipients.

### Reliability and scale qualification

Measure room growth, history depth, event replay, thread traversal, search, attachments, fan-out, and reconnect behavior. Bound every user-controlled collection and queue. Use pagination/cursors, backpressure, load shedding, and per-identity limits alongside per-IP controls.

Test hot rooms and noisy tenants separately from aggregate throughput. Maintain tenant authorization at search and object-storage boundaries. A shared cache must not key only by a document ID when visibility differs by account, room, or access version.

For files and previews, add malware scanning where appropriate, content-type verification, signed access, size limits, safe download headers, and sandboxed rendering. Untrusted HTML or generated applications must not execute in the authenticated room origin.

Define provisional service objectives only after a representative load baseline. Before enterprise commitments, demonstrate recovery-time and data-loss objectives through a restore drill on the actual provider/runtime. Do not use an old-schema writer as rollback or reset durable data to make a release appear healthy.

## 10. AEO, SEO, and agent usability

### Three distinct outcomes

1. **Discovery:** people and assistants can find the correct public product pages.
2. **Understanding:** answers describe Project Room's real capabilities, limitations, identity, and availability accurately.
3. **Actionability:** an authorized agent can discover the supported contract and complete a bounded task without guessing or leaking credentials.

Google says its existing search fundamentals apply to AI features; it does not require special AI text files or schema, and inclusion is not guaranteed.[^20] The plan therefore defines “excellent AEO” as controllable quality gates and measured outcomes, not a universal perfection score.

### Canonical identity before distribution

Choose one owner-approved public product origin and consistent Project Room identity. Document how it relates to the company without conflating it with Demigod's other product or Dasha Compute. Keep old entry links working through deliberate redirects and migration tests. Do not pick or purchase a domain from this plan.

Public marketing/docs can be indexable while authenticated application routes remain private. Keep staging, invitations, account pages, diagnostics, exports, and private rooms out of indexing. Robots directives are not authentication. A URL with a secret must not enter analytics, public sitemaps, page previews, or documentation examples.

The current noindex pilot door should remain unchanged until the public-page review and publication decision. The new acquisition objective changes the roadmap, not today's authorization to publish.

### Public information architecture

Create a small, maintained set of useful pages rather than hundreds of generic AI-written keyword pages:

| Page | Question it answers | Required proof or content |
| --- | --- | --- |
| Product home | What is Project Room, and who is it for? | Concise definition, actual interface, current availability |
| How it works | What does a real team do here? | A complete example from invitation to reviewed result |
| Agents | Can I use my agent, and what can it do? | Supported/tested routes, permission model, limitations |
| Small teams | Why use it for a project? | Specific studio/research/maintainer workflows |
| Enterprise | What controls exist? | Available versus planned controls; contact path only when operational |
| Security and privacy | Who can see data? | Data flow, scope, retention, subprocessors when applicable, incident contact |
| Integrations | What actually connects? | Versioned compatibility and setup instructions |
| Comparisons | When is this a better or worse fit? | Fair task-level comparisons, dated sources, missing capabilities |
| Pricing/availability | What will it cost, and can I join? | Approved real plans or honest pilot access; no invented tiers |
| Docs/quickstart | How does an agent perform a task? | Tested minimal path, auth, error recovery, version |
| Changelog/status | What changed and what is working? | Release evidence and real incident information |

Start with the first four plus security/availability and a tested quickstart. Expand only when each page has distinct useful information and a maintenance owner. Comparison pages should include “not a fit if…” and avoid unsupported competitor claims.

### Technical SEO checklist

- Render primary public content as accessible HTML with stable headings, links, titles, descriptions, and canonical URLs.
- Use accurate sitemap entries and meaningful modification dates; exclude private and parameterized utility pages.
- Make HTTP status codes, redirects, robots directives, and canonical links agree.
- Prevent staging duplication and accidental public indexing of user-generated content.
- Add structured data only where applicable and consistent with visible content. Do not invent ratings, awards, reviews, organization identities, prices, or FAQ eligibility.
- Provide useful social previews for public pages. Private artifact/invitation previews use generic metadata that reveals no room title or content unless explicitly permitted.
- Test mobile performance, accessibility, broken links, unavailable JavaScript, and crawler access through the real edge/security layer.
- Keep headings and body copy clear for readers; do not add hidden keyword paragraphs or crawler-only claims.

### AI crawler policy

Document separate choices for search discovery, model-training crawlers, and user-initiated retrieval. OpenAI documents independent OAI-SearchBot and GPTBot controls, while ChatGPT-User is user-initiated and is not the search-indexing control.[^21] Do not infer that blocking training must block public search discovery, or that allowing a user agent grants it private access.

Verify relevant providers' current official guidance before applying rules. Maintain an owner-approved policy for public pages, validate it against the deployed edge, and keep authentication mandatory regardless of crawler identity. Do not bypass anti-abuse protections merely because a request uses a familiar bot name.

### Machine-readable documentation

Keep a concise `llms.txt` index and detailed task-oriented Markdown docs if they help tested clients. The current llms.txt v2 remains a proposal; it recommends discoverable Markdown alternatives and link relations, not guaranteed search ranking.[^22] Treat it as documentation engineering, not a magic SEO artifact.

Generate public capability cards, OpenAPI descriptions, and human docs from a shared capability registry where feasible. Each capability should record status, supported versions, authentication, scope, side effects, and a tested example. Private room/member facts never belong in public discovery.

An `agent.json` file or A2A-shaped filename does not establish protocol implementation. List MCP, A2A, webhook, and portable-brief support separately. Claim only versions and flows that passed conformance tests. Pin protocol versions and assess new releases explicitly rather than silently following a moving draft.

### Agent quickstart contract

The minimal path should answer: what is this service; what works today; how do I obtain authorized access; what can I read; how do I contribute; how do I know it worked; what do I do when it fails?

Use a bounded sequence: discover → check availability → authorize → inspect scope → read selected context → propose/perform allowed operation → retrieve result/receipt. A preview stops after its supported step. Never return a joined-success state when no membership exists.

Examples use placeholders and secure credential handling, never real keys or query-string bearer tokens. Error responses distinguish expired access, missing scope, stale revision, rate limit, unavailable feature, and retryable service failure. Retries have bounds and idempotency guidance. Long-running work exposes status and cancellation honestly.

### AEO acceptance suite

Maintain a versioned set of 40 evaluation prompts: ten product/fit questions, ten comparison questions, ten setup/action questions, and ten privacy/limitation questions. Examples include “Can my existing agent join?”, “Does mentioning it spend money?”, “Can a client see our other rooms?”, “Is hosted execution available?”, and “When should I keep Slack instead?”

For each prompt, maintain approved facts and disallowed claims. Evaluate public document retrieval separately from actual assistant answers and agent task completion. Record engine, model/version when visible, date, locale, prompt wording, evidence URLs, output, and result. Sample across multiple engines; repeat a subset to expose variability. These checks are experiments, not universal rankings.

Hard release gates: no exposed secrets/private records; no unsupported live-feature, security, or pricing claims; no broken advertised setup path; no infinite retry/join loop; human and machine capability status agree. For softer outcomes, track correct answer coverage, relevant citations, qualified visits, and successful authorized tasks over time without claiming a baseline today.

Google includes AI-feature traffic within overall Web reporting in Search Console; do not present it as a perfectly separated attribution channel.[^20] Bing's AI Performance preview reports citations and cited pages but explicitly does not measure rank or page authority.[^23] Combine available search evidence with referrals, voluntary “how did you hear?” responses, and actual activation. Do not equate a crawler request with a human lead.

### Public artifact growth, later

An accepted result can become a public case study or template only through explicit publication. Build a preview listing exactly what will be public, exclude private references and participant identities by default, and preserve a private original. Publication should create a reviewed snapshot, not expose a live private room by toggling one broad permission.

Explain that removing the hosted page cannot recall copies already made by search engines or recipients. Establish abuse reporting and moderation before indexing public user content. Avoid thin auto-generated public pages and invented testimonials.

## 11. Retention, word of mouth, and healthy engagement

### The core loop

**A real reason to gather → an easy first contribution → a useful shared outcome → a clear reason to return → a relevant invitation.**

The room becomes valuable through people and accumulated context. It should not manufacture activity when nobody has anything useful to say. Agents should reduce friction and extend capability, not impersonate community interest.

### Activation

Define the first useful room moment as at least two real people participating, with either a human-acknowledged useful agent contribution or a useful human-to-human exchange. Separate agent-assisted and conversation-only activation so the product does not penalize social use or force AI into every session.

Recruit a small, opt-in design-partner cohort. Help them move one real project, not their whole archive. Record where they hesitate, which context they copy elsewhere, and whether a collaborator returns without prompting. Recruitment counts are research plans, not projected customers.

### Return loops

- **Conversation:** a reply from someone the person cares about, with quiet controls and accurate unread state.
- **Work:** a result ready to inspect, a concrete question, or a handoff needing acknowledgment.
- **Memory:** a room shelf or decision that saves re-explaining earlier work.
- **Ritual:** an optional weekly review, build session, or reference exchange chosen by the group.
- **Identity:** a room feels like a familiar place without becoming a compulsory public profile.

Notifications default to direct relevance, not every agent update. Provide per-room mute, quiet hours, digest controls, and an easy stop. Ask for push permission only after the person experiences a reason to want it. Do not silently enable email or use a manufactured “someone misses you” message.

### Word-of-mouth loops

1. **Artifact invitation:** “Can you review this?” brings a collaborator into a useful task.
2. **Template reuse:** a successful room process can be copied without private data.
3. **Client collaboration:** a studio invites a client who later creates a room for their own team.
4. **Public proof:** a voluntarily published result demonstrates the product through something worth sharing.
5. **Agent connector:** a developer connects once and helps another team use the same documented route.

Build the first two before referral rewards or a marketplace. Evaluate whether invitations create retained rooms, not merely sign-ups. Respect existing community rules when sharing examples; founder-led outreach should be personal, authorized, and limited.

### More worthwhile hours

Longer sessions are valuable when people are genuinely collaborating, exploring, or socializing. Shorter sessions are valuable when the product helps them find an answer and leave. Track active human engagement as a diagnostic alongside outcomes and satisfaction; exclude background tabs, unattended agents, streaming tokens, and idle polling.

Do not rank employees by time online, compel read receipts, sell a surveillance dashboard, or optimize agents to keep conversations going. If usage rises while notification complaints, unresolved work, or user regret rises, treat that as harm—not growth.

## 12. Measurement plan

Use a small operating scorecard rather than a wall of metrics. The HEART work provides a useful precedent for connecting product goals to user-centered signals; it is not a source of Project Room benchmarks.[^24]

### Candidate selection

Raw messages, total agent calls, token consumption, sign-ups, and total time are easy to inflate and weak standalone outcomes. Completed work alone undercounts social value. Invitations alone can reward spam. Use retained collaborative rooms and successful first value as the primary outcomes, with carefully defined drivers.

| Primary measure | Proposed definition | Decision supported | Main caveat |
| --- | --- | --- | --- |
| Week-4 retained collaborative rooms | Activated rooms with a qualifying human collaboration during days 22–28 after activation, divided by activated rooms old enough to observe that window | Does the core experience earn return? | Small cohorts and project completion can distort interpretation |
| First-week useful activation | New eligible rooms reaching a qualifying shared interaction within seven days, divided by all new eligible rooms | Is onboarding delivering real value? | Must exclude fixtures, staff tests, bots, and duplicate room retries |
| Retained invitation conversion | Eligible accepted invitations whose new participants contribute and return in the defined observation window, divided by eligible delivered invitations | Are invites creating durable value? | Delivery and identity deduplication need a clear definition |

For the third measure, begin with contribution within seven days of acceptance and a separate return during days 8–14. Count invitations by unique invitation/recipient where known; anonymous links require a separately reported link-join cohort, not guessed recipients. Do not pool the denominators.

Define qualifying collaboration before instrumenting: at least two human members take deliberate actions in the room during the window, with a reply/reaction/review or another explicit response connecting participation. Human acceptance/reuse of an agent result can qualify when the room still has actual multi-human participation. Report one-human-plus-agent rooms separately, not as fake team retention.

Drivers: time to first contribution and invitation-entry completion for activation; useful replies/results and successful catch-up for retention; invitation destination completion and first-week recipient participation for invitation conversion. Segment by team type, room age, device, guest/member status, and agent-connected versus conversation-only use.

Guardrails: privacy/security incidents and failed/duplicate user operations; notification dissatisfaction/opt-outs and user-reported usefulness. Monitor cost per useful agent-assisted outcome separately before hosted execution expands. Security failures are release blockers even when growth improves.

### Instrumentation contract

Create versioned event definitions for invitation opened/accepted, room entered, message committed, reply committed, result opened/accepted/reused, access denied, connection checked, operation failed/retried, and notification preference changed. Record actor kind so agents cannot inflate human metrics. Dedupe by operation ID and use server confirmation for committed actions.

Do not log message bodies, drafts, prompts, credentials, raw private URLs, or customer names into growth analytics. Use pseudonymous IDs, a documented retention period, restricted analyst access, and organization-level controls. Client activity measurement must be transparent and must not become keystroke or screen recording.

Separate event time from ingestion time, define UTC windows and reporting delays, exclude internal/test environments, and maintain schema checks. Validate a handful of synthetic journeys end-to-end before using the scorecard. Keep human qualitative feedback beside metrics, especially with small cohorts.

### Targets and experiments

Do not invent a target retention percentage from competitor marketing. Establish a baseline over complete cohorts, then set improvement targets with realistic sample sizes and staffing. Early pilot release criteria should be concrete journey success and no unresolved high-severity trust failures, not statistically weak conversion lifts.

Test one major onboarding or notification change at a time. Randomize at room/team level where possible because participants influence one another. Predefine the outcome window, exclusions, and guardrails; do not declare a winner from a few enthusiastic users. When numbers are small, use observed task success and interviews as directional evidence and say so.

## 13. Adoption, migration, and commercial model

### Adoption sequence

Start with founder-led design partnerships, permissioned demos, and a handful of concrete workflows. Publish a useful example only with participant approval. Make a visitor understand the product through a short real workflow, not a vague platform manifesto.

Migration should be incremental: link existing material, selectively import a project, map participants and permissions, preview the result, then invite collaborators. Preserve original timestamps and authorship where supported, label imported content, prevent duplicate imports, and report unsupported fields. Never turn imported mentions into live notifications or map missing identities into the owner's privileges.

Start with a read-only bridge or deliberate share from an existing tool. Two-way bridges require deduplication, loop prevention, edits/deletion semantics, audience mapping, and clear notification ownership. Avoid cross-posting confidential content because a channel name matches.

### Pricing hypotheses

Research willingness to pay after teams experience the core loop. A plausible structure is a usable free small-room experience, a paid team tier for collaboration capacity and shared controls, and an enterprise tier for administration, assurance, support, and deployment requirements. This is a hypothesis, not an approved price sheet.

Avoid charging for fake agent “seats” that discourage useful participation. Separate BYO-agent connectivity from any future hosted-compute costs. Explain storage, retention, guests, and execution limits in plain language. Do not hide essential export or safety behind a deliberately hostile exit experience.

Before selecting prices, conduct structured interviews and test packaging against actual usage/cost. No payment infrastructure, money movement, or subscription change follows from this document.

### Brand and storytelling

Keep Project Room distinct and consistent across the public site, app, repo, docs, agent cards, and shared previews. Tell stories about a team making a decision or producing something—not a fictional autonomous workforce. Use actual participants and consented examples; do not imply partnerships with supported tools.

The first demo should fit one coherent story: invite a colleague, connect an approved agent, ask a real question, inspect a result, request a change, accept the right version, and return later to the decision. Ordinary chat should look inviting throughout.

## 14. Delivery roadmap

These phases are dependency-based planning envelopes, not promised dates. Calendar estimates assume a small team with dedicated engineering, product/design, and shared security/operations capacity. Confirm staffing and the audit repair size before committing dates. If capacity is one implementer, keep one feature slice active at a time.

### Phase 0 — trustworthy foundation, approximately weeks 1–3

**Outcome:** the existing product is safe enough for deliberate pilot expansion.

- Close the documented auth, relink, session-policy, recovery, diagnostics, and source-provenance blockers with independent regression evidence.
- Complete the remaining 28-scenario audit dispositions; do not silently call untested scenarios passed.
- Publish an internal available/preview/planned capability registry.
- Qualify the public MCP preview's exact protocol/error behavior without enabling public membership.
- Establish an exact build/test/release manifest and a restore drill on the intended provider.

**Exit:** no unresolved release-blocking trust finding in the pilot scope; negative and legitimate positive paths pass; rollback/recovery demonstrated; source version unambiguous. Growth work may be designed in parallel but must not send users into broken access paths.

### Phase 1 — delightful small-team core, approximately weeks 3–6

**Outcome:** a team can join, converse, use an agent, review, and return without operator help.

- Prototype and test invitation/sign-in/return, room shell, composer, agent connect, result review, and mobile back behavior.
- Apply the copy-removal inventory and visual tokens to existing components.
- Improve one complete agent-assisted workflow rather than adding many tools.
- Ship/qualify Needs you and room shelf as views over current records.
- Instrument the minimal scorecard and recruit the first consented design partners.

**Exit:** real participants complete the core journey on desktop and phone; privacy/cost meaning is understood; failures preserve work; no essential action depends on hover. Report unsuccessful sessions as evidence, not exceptions to hide.

### Phase 2 — differentiation and return, approximately weeks 6–10

**Outcome:** teams prefer Project Room for a repeated workflow.

- Add compact context handoff, compare results, and safe Use again templates.
- Improve catch-up, notification controls, and permission-aware search.
- Pilot purpose-specific invitations and one lightweight group ritual.
- Qualify a second independently tested agent connection route and one selective external-tool import.
- Measure complete activation/return cohorts and interview dropouts as well as enthusiasts.

**Exit:** repeated real use without founder prompting, inspectable evidence of reduced coordination friction, and acceptable guardrails. Numeric commercial targets are set only after baseline measurement.

### Phase 3 — public discovery and enterprise pilots, approximately weeks 10–16

**Outcome:** public claims are trustworthy, and a small enterprise department can evaluate controls.

- Launch owner-approved canonical public pages, clean redirects, SEO checks, and machine-readable docs.
- Run the 40-prompt AEO evaluation and advertised agent-task journeys.
- Add enterprise identity/provisioning and administrative controls prioritized by actual pilot requirements.
- Complete a security assessment and a qualified support/incident process.
- Test migration and packaging with design partners; avoid big-bang migration promises.

**Exit:** accurate public availability, no private indexing, documented pilot controls, offboarding/recovery proof, and clear support ownership. Certifications remain separately scoped projects.

### Phase 4 — earned expansion, approximately months 4–6 and beyond

**Outcome:** broaden use without losing the quiet core.

- Expand consumer/community features based on observed demand: events, polls, richer expression, direct/group messages, and qualified audio.
- Add public result/template sharing only after publication review and moderation exist.
- Consider hosted execution, additional adapters, and enterprise deployment options based on economics and support capacity.
- Revisit deferred ideas against real repeated needs; remove experiments that do not earn continued use.

**Exit:** expansion preserves core performance, trust, and clarity. Every optional feature has an owner, support plan, measurable purpose, and a removal strategy.

## 15. Implementation backlog and ownership boundaries

Priority is qualitative: P0 blocks safe expansion; P1 creates core value; P2 differentiates/retains; P3 expands after evidence. These are proposed work packets, not automatic assignments or permission to edit occupied files.

| ID | Priority | Packet | Dependencies | Acceptance criterion |
| --- | --- | --- | --- | --- |
| F01 | P0 | Shared read/auth boundary | Existing route inventory | Thread/search/export aliases reject wrong credential modes consistently |
| F02 | P0 | Session policy consolidation | Grok G2 regressions | Generic and dedicated routes enforce identical live policy |
| F03 | P0 | Enforcement provenance | F02 | Clients cannot author server enforcement facts |
| F04 | P0 | Relink/revocation correctness | Current identity model | Narrow reconnect never widens privileges; active paths recheck access |
| F05 | P0 | Authority-aware restore | Recovery audit | Invites/revocations/cleanup survive verified restore without resurrection |
| F06 | P0 | Bounded/redacted diagnostics | Route inventory | Global bounds and no user-ID leakage in route templates |
| F07 | P0 | Exact release manifests | Build tooling | Tests and deployed bytes match an inspectable immutable artifact |
| F08 | P0 | Truthful state contract | Session/review model | Online/Running/Ready/Accepted cannot contradict underlying evidence |
| U01 | P1 | Invitation and return prototype | F01/F04 | Correct destination and least-privilege return on phone/desktop |
| U02 | P1 | Quiet room shell and tokens | Existing components | Stable navigation, readable density, accessible focus |
| U03 | P1 | Copy inventory and removal | U02 | Every persistent string has a purpose; essential meaning retained |
| U04 | P1 | Composer and thread reliability | F01 | Draft, keyboard, IME, retry, scroll and touch journeys pass |
| U05 | P1 | Agent connect experience | F04/F08 | Real state, operator, scope, tested route, no credential leakage |
| U06 | P1 | Result-first review | F08 | Review exact artifact version; changed result is unmistakable |
| U07 | P1 | Needs you view | Shared state | Correct per-user items, quiet clearing, no private-mail bleed |
| U08 | P1 | File/preview safety | Storage boundary | Safe authorized upload/open/delete, sandboxed active content |
| D01 | P2 | Room shelf | U06/F04 | Saved objects retain source, version, and access checks |
| D02 | P2 | Compact context handoff | F02/F04 | Selection preview, accepted scope, stale-context indication |
| D03 | P2 | Compare results | U06 | Alternatives compared without overwriting selection/history |
| D04 | P2 | Use again templates | D01/D02 | No secrets, private history, or inherited grants in copies |
| D05 | P2 | Review session queue | U06 | Participants know current item; host can manage; exit is easy |
| D06 | P2 | Shared attention | U08 | Following an object grants no control or extra access |
| G01 | P1 | Minimal measurement events | Privacy review | Human/bot split, dedupe, no content/secret collection |
| G02 | P1 | Design-partner journeys | U01/U04/U05 | Observed tasks and failed attempts recorded with consent |
| G03 | P2 | Purposeful invitations | U01/G01 | Invite lands on permitted object; no spam automation |
| G04 | P2 | Return/notification experiments | U07/G01 | Retention evaluated with opt-out/usefulness guardrails |
| A01 | P1 | Canonical brand/origin decision | Owner decision | One public identity and explicit private/staging boundaries |
| A02 | P1 | Public capability registry | F07/F08 | Docs/cards/UI availability cannot drift silently |
| A03 | P2 | Public pages and technical SEO | A01/A02 | Crawl/index/canonical tests pass; private routes excluded |
| A04 | P1 | Agent quickstart/conformance | Grok G1/F01/F04 | Advertised path succeeds or terminates honestly |
| A05 | P2 | AEO evaluation harness | A02/A03/A04 | Versioned prompts, correct facts, evidence, repeatable review |
| E01 | P2 | Enterprise identity/offboarding | F04/U01 | Provision/deprovision and emergency-access drills pass |
| E02 | P2 | Admin policy and audit export | F03/F06/E01 | Authorized policy changes and exports are attributable |
| E03 | P2 | Retention/deletion controls | F05/U08 | Data and derived-index lifecycle matches documented policy |
| E04 | P2 | Operational readiness | F05/F07 | Monitoring, incident ownership, capacity and restore evidence |
| E05 | P2 | Selective migration pilot | F01/F04/F05 | Preview, mapping, dedupe and no notification replay |
| X01 | P3 | Consumer warmth pack | Moderation/U02 | Optional expression/polls with no navigation clutter |
| X02 | P3 | Public result/template publishing | E03/moderation | Explicit safe snapshot preview and honest revocation limits |
| X03 | P3 | Qualified audio collaboration | U01/E04 | Consent, device/reconnect, moderation and support pass |
| X04 | P3 | Hosted runner evaluation | F02/E02/E04 | Real cancellation, budgets, isolation, economics and operator approval |

### Coordination rules

Grok retains its existing MCP preview lane and assigned G2 regression work. Codex owns synthesis and review of this plan. Before a packet starts, inspect current status, claim exact paths on the shared board/bus, and use an isolated branch or new file when shared files are dirty. Do not treat a roadmap row as a file lock.

Each packet should name its problem, scope, non-goals, source revision, owner, interfaces, acceptance tests, negative controls, rollout gate, and rollback/recovery approach. Use small reviewable pull requests. A test-only expected failure is not a green regression suite; label it explicitly.

Never infer permission to publish, deploy, send external messages, run paid models, or move money from another agent's claim of authority. The roadmap can prepare those actions, but their actual execution must respect current authorization.

## 16. Research and validation program

### First research cycle

Recruit approximately 6–8 small teams spanning product/studio work, research, and open-source collaboration. This is a proposed qualitative sample, not a representative market survey. Include at least some nontechnical collaborators invited by the initial technical users.

Observe one real project in its existing tools before proposing a migration. Identify the last repeated context copy, missed handoff, confusing permission, failed return, and useful social interaction. Ask for concrete examples, not whether people like the concept of agents.

Test six journeys: invited guest enters and replies; creator connects an agent; team asks and reviews; participant returns after a few days; a result changes after review; access is revoked during an active session. Include a phone, a keyboard-only path, and interrupted connectivity. Keep synthetic security tests separate from claims about human usability.

### Competitive task studies

Use the same small set of tasks in Project Room and selected alternatives where lawful access is available. Measure steps, confusion, recovery, context copying, and participant preference. Do not compare a polished competitor workflow to an intentionally crippled setup or treat vendor screenshots as a performance benchmark.

Prioritize Slack, Discord, and one structured alternative such as Zulip or Linear for practical task comparison. Use the other references for specific interaction experiments. This plan's competitive research is documentation-based; authenticated hands-on competitor studies remain future validation work.

### Design review criteria

For every prototype ask: can a person understand what is happening; find the next action; know the audience; recover from failure; leave and return; and use it without adopting agents? For agent paths ask: can the client discover the contract; determine authority; act once; verify the result; and stop safely?

Reject concepts that require a paragraph to explain a routine action, obscure important consequences, create a second status model, or generate engagement without a user benefit. Keep an experiment archive so discarded ideas do not return under new names without new evidence.

## 17. Decisions, risks, and sequencing

The highest-risk strategic mistake is expanding surface area before the core room earns repeated use. The highest-risk technical mistake is presenting agent controls as guarantees when only reporting exists. The highest-risk growth mistake is exposing private material or overstating readiness to improve discovery.

Unresolved decisions are the canonical public origin/brand relationship, sign-in implementation, initial paid packaging, precise enterprise pilot requirements, staffing, and whether/when hosted execution becomes part of the product. None blocks research or safe local refinement, but each must be settled before dependent public commitments.

The first implementation order should be F01–F08 in dependency-sized slices, alongside non-production U01–U06 prototypes and A01/A02 planning. Then qualify one complete small-team loop. Only after that should public acquisition, enterprise pilots, and larger consumer features expand.

The simplest long-term test is this: **does Project Room make a group more capable while asking less of its attention?** If a feature does not improve that answer, it should not earn a permanent place in the interface.

## 18. First two working cycles

### Cycle A: establish truth and test the shape

**Engineering:** review Grok's G2 test handoff, agree on the shared live policy boundary, and implement the smallest F02/F03 repair on an isolated revision. In a separate non-overlapping slice, qualify F01 route handling. Start F05 recovery design before changing storage. Keep the exact baseline and regression commands in every review.

**Product/design:** create clickable prototypes for invite → room → agent contribution → result review → return. Use real-shaped but synthetic content, including a long conversation, a failed connection, an expired invite, and a changed result. Compare one chat-first layout with one overly structured alternative to test whether the extra structure actually helps; do not assume visual minimalism alone wins.

**Content/discovery:** inventory all public capability claims and label them available, preview, planned, or unsupported. Resolve contradictions before producing more pages. Draft the canonical identity decision, but do not change DNS, crawler policy, or public routing.

**Research:** prepare consent and recruit the first appropriate teams. Observe existing work and use the prototypes with invited nontechnical collaborators. Deliver findings organized by task failure and severity, not a list of subjective aesthetic preferences.

**Checkpoint:** a verified boundary repair or clearly bounded blocker, an actionable prototype review, and a truthful capability inventory. No claim that the entire product has been redesigned.

### Cycle B: qualify the smallest complete experience

**Engineering:** address the highest-severity first-use failures, preserve drafts and reading position, and connect UI state to the shared status contract. Add only the measurement events needed for the first journey. Complete recovery/source-provenance prerequisites before growing the pilot.

**Product/design:** apply the approved visual system and copy decisions to one full journey. Test touch and keyboard behavior on the implementation, not just the prototype. Record which removed labels needed to return because people could not find or understand the action.

**Content/discovery:** run the first public-document consistency checks and the setup-question portion of the AEO suite against a local/staging capability snapshot. Keep preview limitations explicit. Prepare public content for later approval rather than indexing the private pilot prematurely.

**Research:** watch participants complete and revisit an actual permitted task. Ask what they still moved back to Slack, Discord, documents, or a private agent session, and why. Distinguish missing features from distrust, unclear language, poor performance, and absent teammates.

**Checkpoint:** a demonstrable end-to-end improvement, test evidence, observed usability failures addressed or scheduled, and a narrow next slice. If the basic loop still needs operator rescue, do not compensate by adding a marketplace or a public launch.

## 19. Starter AEO evaluation set

These are test inputs, not production FAQ copy. Expected answers must be generated from the capability registry for the evaluated release; a plan is never the source of truth for what is live. Product and comparison questions test factual understanding, while action questions require an actual qualified path or an honest stop.

### Product and fit

1. What is Project Room?
2. Who is Project Room best suited for today?
3. Can a room be useful without an AI agent?
4. Can several people work with different agents in the same room?
5. Is Project Room a task tracker, a chat app, or both?
6. Can a client join one project without seeing our other rooms?
7. Is Project Room publicly available or still a pilot?
8. Does Project Room run models, or do I bring my own agent?
9. How does Project Room relate to Demigod and Dasha Compute?
10. Which Project Room website and documentation are authoritative?

### Comparison and selection

11. When should a small team choose Project Room instead of Slack?
12. When should we keep using Slack?
13. Is Project Room a replacement for a large Discord voice community today?
14. How is Project Room different from adding a bot to a group chat?
15. How does it compare with Teams for enterprise administration?
16. How does it compare with Zulip for asynchronous discussions?
17. Why use Project Room alongside Linear rather than replacing Linear?
18. How are shared agent permissions different from a private assistant's permissions?
19. Can we try one project before migrating our organization?
20. Which advertised capabilities remain planned or preview-only?

### Setup and action

21. How do I join a room from an invitation?
22. How do I return after closing my browser?
23. How do I connect an agent I already use?
24. Which MCP transport and version are supported by this release?
25. What should an agent do when public joining is unavailable?
26. How does an agent check its current permissions?
27. How do I give an agent only the context for one task?
28. How do I retry an operation without posting twice?
29. How do I review the exact version of an agent's result?
30. How do I stop work, and how do I know the runner stopped?

### Privacy, limitations, and trust

31. Does mentioning an agent automatically grant access or spend money?
32. Can an agent reveal information its operator can see but the room cannot?
33. Are private rooms or invitations visible to search engines?
34. Where should I put credentials when connecting an agent?
35. What happens when an agent or member is removed?
36. Does reconnecting an agent restore its previous permissions?
37. Are budget limits enforced by the runner or only reported?
38. What data is included in exports, and has restore been tested?
39. Is Project Room end-to-end encrypted or certified for enterprise compliance?
40. What happens to copies after a published result is removed?

### Evaluation record and failure handling

For each case store prompt ID, evaluated release, approved fact references, engine/client, timestamp, answer or operation trace, citations, factual errors, unsupported claims, and outcome. Do not store real credentials or private prompts in the evaluation corpus. Mark unknown/not observable instead of guessing a model version or hidden retrieval step.

A factual error triggers a review of the source page, metadata, aliases, and stale documentation before adding more copy. An agent-action failure triggers a contract or product fix before another onboarding paragraph. A privacy failure blocks release. A missing citation without factual error is a visibility observation, not automatic evidence that the product is broken.

## Sources

Official/vendor documentation is used for described capabilities; the adaptations and roadmap are Project Room recommendations. All links were reviewed September 12, 2026. Undated pages are cited by access date rather than an invented publication date. Historical sources are used for design principles, not current feature availability.

[^1]: Slack. [Slack Features](https://slack.com/features). Current product overview; accessed September 12, 2026.
[^2]: Discord. [Community Onboarding FAQ](https://support.discord.com/hc/en-us/articles/11074987197975-Community-Onboarding-FAQ). Page displays March 31, 2023; accessed September 12, 2026.
[^3]: Microsoft Support. [How to use Microsoft Copilot in Teams group chats](https://support.microsoft.com/en-us/teams/chat-channels/how-to-use-microsoft-365-copilot-in-teams-group-chats). Public-preview qualification retained; accessed September 12, 2026.
[^4]: Zulip. [Introduction to topics](https://zulip.com/help/introduction-to-topics). Accessed September 12, 2026.
[^5]: Linear. [Developing the Agent Interaction](https://linear.app/developers/agent-interaction), and [Linear Method](https://linear.app/method). Accessed September 12, 2026.
[^6]: Notion. [Custom Agent sharing and permissions](https://www.notion.com/en-gb/help/custom-agents-sharing-and-permissions). Accessed September 12, 2026.
[^7]: Basecamp. [Hill Charts](https://basecamp.com/hill-charts). Accessed September 12, 2026.
[^8]: Discourse. [Solved](https://www.discourse.org/plugins/solved.html). Accessed September 12, 2026.
[^9]: Element. [Secure collaboration for enterprises](https://element.io/solutions/secure-collaboration). Vendor-described capabilities, not independently certified here; accessed September 12, 2026.
[^10]: Signal. [Phone Number Privacy and Usernames](https://support.signal.org/hc/en-us/articles/6712070553754-Phone-Number-Privacy-and-Usernames); [Link Up with Group Links](https://signal.org/blog/group-links/), October 28, 2020. Accessed September 12, 2026.
[^11]: Spotify Support. [Start or join a Jam](https://support.spotify.com/us/article/jam/). Accessed September 12, 2026.
[^12]: Partiful. [Online RSVP](https://partiful.com/invitations/online-rsvp); [How can I send Partiful invites via email?](https://help.partiful.com/en-us/articles/15525331-how-can-i-send-partiful-invites-via-email), June 16, 2026; [RSVP controls](https://help.partiful.com/en-us/articles/15525368-how-do-i-modify-the-types-of-rsvps-that-are-allowed). Accessed September 12, 2026; inconsistent account-friction claims noted in section 4.
[^13]: Are.na. [Product home](https://www.are.na/). Accessed September 12, 2026.
[^14]: Figma Learn. [Present to collaborators using spotlight](https://help.figma.com/hc/en-us/articles/360040322673-Present-to-collaborators-using-spotlight). Accessed September 12, 2026.
[^15]: Raycast Developers. [Action Panel](https://developers.raycast.com/api-reference/user-interface/action-panel). Accessed September 12, 2026.
[^16]: Victoria and Albert Museum. [Writing Gallery Text at the V&A](https://www.vam.ac.uk/blog/wp-content/uploads/VA_Gallery-Text-Writing-Guidelines_online_Web.pdf), especially text hierarchy and language guidance. Publication date not established from the reviewed extract; accessed September 12, 2026.
[^17]: Nintendo. [Iwata Asks: Miiverse, The Producers, page 2](https://iwataasks.nintendo.com/interviews/wiiu/miiverse/0/1/). Historical Wii U-era interview; accessed September 12, 2026.
[^18]: GitHub Docs. [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets). Accessed September 12, 2026.
[^19]: Model Context Protocol. [Transports, specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports); [Authorization, specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization). Version-pinned reference, not a claim it is the latest release; accessed September 12, 2026.
[^20]: Google Search Central. [AI features and your website](https://developers.google.com/search/docs/appearance/ai-features). Updated December 10, 2025; accessed September 12, 2026.
[^21]: OpenAI. [Overview of OpenAI Crawlers](https://developers.openai.com/api/docs/bots). Accessed September 12, 2026.
[^22]: Jeremy Howard. [The /llms.txt file, v2](https://llmstxt.org/). Original publication September 3, 2024; modified August 10, 2026; accessed September 12, 2026.
[^23]: Bing Webmaster Blog. [Introducing AI Performance in Bing Webmaster Tools Public Preview](https://blogs.bing.com/webmaster/February-2026/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview). February 10, 2026; accessed September 12, 2026.
[^24]: Kerry Rodden, Hilary Hutchinson, Xin Fu. [Measuring the User Experience on a Large Scale: User-Centered Metrics for Web Applications](https://research.google/pubs/measuring-the-user-experience-on-a-large-scale-user-centered-metrics-for-web-applications/). CHI 2010; accessed September 12, 2026.
[^25]: W3C WAI. [What's New in WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/); [Understanding Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum). Accessed September 12, 2026.
[^26]: web.dev. [Web Vitals](https://web.dev/articles/vitals). Accessed September 12, 2026.
[^27]: Nielsen Norman Group. [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/); [Icon Usability](https://www.nngroup.com/articles/icon-usability/). Foundational usability guidance; accessed September 12, 2026.
[^28]: OWASP Gen AI Security Project. [LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/). Accessed September 12, 2026.
