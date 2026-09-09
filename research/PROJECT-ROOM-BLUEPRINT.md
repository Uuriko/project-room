# Project Room: unified product blueprint

Version 1 · September 8, 2026 · Consolidated planning entry point

## 1. The product we are building

**A shared place to talk, stay connected and get things done—with people and agents, across the tools they already use.**

Project Room has three equally legitimate everyday uses:

- Talk: spend time together, ask questions, exchange ideas and share things without creating tasks.
- Reply: read and respond to personal and shared conversations across connected channels.
- Work: deliberately turn an idea or request into an outcome, bring in help, review the result and, when agreed, reward contributors.

The ambition is broader than a task tracker or shared chatbot. It is a collaborative workspace with unified communications, interchangeable agent participation, optional execution and a network of useful work. The interface must not require users to understand that entire architecture.

The first evaluated work journey remains a request becoming a reviewed deliverable. That is our initial acceptance test, not a restriction on the product's identity. Ordinary chat and direct replies must be worthwhile without promoting anything into work.

This blueprint consolidates earlier plans and resolves their sequencing differences. It is the starting point for future planning; existing technical contracts, provider constraints and verified implementation records remain authoritative in their own domains. It is not a claim that every screen has been prototyped or every implementation detail is settled. No deployment, new account access, money movement or runtime change is authorized by this document.

## 2. What exists versus what is proposed

The inspected unified local checkout was clean at documentation commit `af1a980`, which records runtime `3984941` and schema 14. This inspection did not rerun application tests or establish the deployed site's version. Older documents describing schema 7, 8 or 9 are historical, not current release guidance.

| Area | Evidence-backed position | Next step |
| --- | --- | --- |
| Native room conversation | Local messages, threads, reactions, scoped search and draft handling exist | Qualify the consolidated conversation-first layout and richer media |
| Work and review | Local versioned work, evidence, reviews, owner decisions and recovery foundation | Finish the human/agent offer experience and verify the complete journey |
| Agent participation | Local managed enrollment, direct client and stdio MCP operations; portable contribution routes | Host-specific compatibility, narrower assignment context and better onboarding |
| Help offers | Durable local schema-14 storage is recorded | Negotiated context/tools, compact offer/select/release controls, compatible recovery |
| Unified external messaging | Researched and designed; not established as connected/live | Synthetic inbox-to-room-to-reply prototype, then one qualified email adapter |
| Hosted assistant and routines | Proposed; existing local watchers do not establish hosted execution | Bounded suggestion tools, shared dispatch/recovery contract and explicit limits |
| Dasha execution | Proposed adapter; no live dispatch established here | Verify the provider contract with a fake runner before using real compute |
| Bounties and payouts | Designed, not established as a live payment product | Versioned reward agreements, accounting and exception drills, then authorized pilot |
| Public opportunity network | Planned | Curated opt-in discovery after private collaboration proves useful |
| Actual adoption and retention | No verified baseline in these research records | Instrument real outcomes; keep simulated-user results labeled |

Do not present a feature as live because a plan, button, API wrapper or synthetic fixture exists. Record local, staging and production evidence separately.

## 3. One interface, optional depth

### Stable navigation

**Inbox and Rooms** are the default primary destinations. Search and the account menu remain easy to find. The account menu contains connections, preferences, billing and personal data controls.

Inbox is a personal attention and conversation list. It can include connected external conversations, native direct messages, invitations and decisions needing the current user. Filters such as All, Unread and Needs you organize the same list; they do not create separate inbox products. Personal accounts and team inboxes retain distinct audiences.

Rooms are persistent spaces for a project, group, community or ongoing relationship. Room conversation is the main surface. A selected work item, source or result opens alongside it on desktop and in a restorable detail view on mobile. The room need not expire when one task finishes.

Find work becomes an optional destination once public discovery exists. It is always findable from a stable menu and can be pinned by the user. Connections, automations, rewards and compute do not each receive mandatory top-level tabs. A room's optional capability list provides a predictable place to enable them.

### A small visual vocabulary

Use conversation, a source card, a work card, a result and a decision as recurring surfaces. A reward is attached to work; a run is an attempt at work; an external message is a source with its original channel identity. These are not separate dashboards by default.

One visually dominant action per active decision or form. Preserve short labels for ambiguous or consequential actions: Reply, Ask room, Review, Share, Send, Add reward. Familiar icons may stand alone with accessible names. Whitespace and hierarchy should replace repeated explanatory text, not remove important audience or cost information.

Always show the acting identity, audience, current ownership when relevant, material cost and uncertainty before consequential actions. Put logs, raw IDs, history and uncommon settings in one predictable details layer. Do not require hover, long-press or a command palette to discover essential actions. Do not unlock controls based on arbitrary account age or silently rearrange navigation.

This uses progressive disclosure as prioritization, not concealment. The source guidance stresses both choosing the right primary controls and making secondary controls discoverable. Our exact layout remains a testable proposal. [NN/g](https://www.nngroup.com/articles/progressive-disclosure/).

### Four levels of use, not four products

1. Everyday: join, talk, reply, share a file and find a result.
2. Assisted: ask a person/agent, draft a reply, turn a message into work, review.
3. Connected: connect accounts/tools, schedule a bounded routine, run approved work.
4. Networked: publish an opportunity, add a reward, assemble a team, manage paid work.

Each level must remain useful without adopting the next. Explicit user preferences may pin frequently used capabilities. A free account is not a deliberately frustrating version of the core product.

### Knowledge and larger projects

Each room can pin its brief, accepted results and durable decisions. Search starts in the current permitted scope, with an explicit option to widen it. A catch-up summary links back to its evidence and distinguishes agreed decisions from suggestions. Reusable templates carry structure, not hidden private history or permissions. Cross-room knowledge sharing is explicit; a general agent memory must not become a back door between audiences.

As projects grow, an optional Work view can show a list, dependencies or board over the same work records. A Results view is a projection of accepted artifacts, not a new document system. Pinning these views is user-controlled. Room-level tools may include files, previews and execution details without forcing every casual participant to see them. Shared rich-text documents, deep repository editing and reusable automation recipes require separate prototypes, but must reuse the room's identity, evidence and permission boundaries.

## 4. Messaging is a first-class product capability

### Native conversation

Support room chat, threads, reactions, references to work/results, attachments and clear human/agent identity. Add native direct and small-group conversations with their own membership boundary; a message addressed to someone inside a room is still room-visible, not a private DM.

Presence reflects observed availability, not a created token or a polling client. Mentions request attention but never grant permission. Casual discussion should not wake every agent. Add selective notification controls, quiet periods, mute, block/report and moderation appropriate to room visibility. Voice notes and calls are ambitious later additions only if they reuse conversation membership and consent controls; recording is never assumed.

Desktop Enter sends ordinary chat; Shift+Enter inserts a line break, with composition and repeated-key protection. Mobile keeps an accessible send control. Email uses multiline entry and a deliberate send action/shortcut. Keyboard shortcuts cannot turn an internal comment into an external send.

### All-in-one external inbox

One conversation list, small persistent channel badges, correct sender account and optional channel filters. Preserve email subjects/recipients, chat reply relationships, attachments and provider-specific states. Do not automatically merge identities or threads because names match across networks.

An outside conversation opens in a room-side panel. Keep the external reply composer and internal room composer visibly separate with separate drafts. On mobile, use full-screen detail and restore the prior room state on return.

Basic reading and replying do not require a work item or AI. Ask room shares only selected text/attachments after an audience preview. The sender does not become a room member. New messages in the original conversation do not automatically expand sharing; ongoing synchronization is an explicit option.

The reverse journey is equally important: review an in-room draft beside its source, check recipients and attachments, then send through the chosen account. Accepted draft, send attempted, provider accepted, delivered and read are different facts, displayed only where the provider supports them. Unknown is a valid state; never blindly resend after a lost acknowledgment.

### Channel expansion policy

First qualify email with a dedicated test account, then a personally authorized pilot. Evaluate an optional local Beeper companion for personal messaging. Beeper documents a local API across multiple networks, requires the desktop to run, recommends personal use, and limits iMessage to macOS; this does not establish permission for unrestricted commercial embedding. [Beeper API](https://developers.beeper.com/desktop-api/).

Keep separate adapter tracks for personal bridges, Telegram bot/business routes, WhatsApp Business, SMS and existing shared-inbox products. They are not equivalent ways to read an entire personal account. Qualify supported account types, policies, history, attachments, edits/deletes, reconnect and send reconciliation per adapter before advertising support. Never label the whole Room/AI workflow end-to-end encrypted just because the source messenger is encrypted.

## 5. Humans and agents share one work system

### Contribution routes

- A person works directly in the browser.
- A connected agent reads, proposes and contributes through the canonical API or a thin MCP adapter.
- A person copies a secret-free brief into any suitable AI and returns an artifact manually.
- An inspected skill teaches a compatible agent how to discover authorized work and report back.
- A repository or other tool retains its native workflow while linked evidence returns to the room.
- The optional Room assistant or an approved execution backend performs bounded work.

These routes share task IDs, revisions, evidence and review semantics. They do not have identical identity assurance, live tracking or cancellation guarantees. A copied packet is not a connection; a skill does not supply a model, quota or a background runner. Publish verified host compatibility separately from untested setup recipes. Messaging-only agents may participate through an authorized channel without receiving direct workspace execution privileges.

### Connection experience

Choose route → select access → private setup → verify access → optionally start a chosen activity. Show no green Working state merely because setup succeeded. Offer a manual fallback. Put expiry, rotation and revoke in accessible connection details. Provider credentials remain in supported secret storage, never copied into ordinary room messages or public prompts.

The current room-wide membership foundation must not be described as assignment-only privacy. Narrow context access requires service enforcement, not an exported packet that politely asks the agent to ignore the rest of the room.

### Work lifecycle and coordination

Conversation becomes a request only deliberately. Requests can receive offers; an accepted assignment identifies the scope, accountable owner and acceptance criteria. Current editor, execution worker, integrator and approver can differ. Defaults should avoid a form for every role, but the records must preserve their different authority.

Default to one worker. Parallelize independent outputs and bounded reviews, not overlapping direct edits. Use resource scopes, current authority and artifact revision checks; preserve alternatives and late work as proposals. A claim is not an external filesystem lock. Takeover must invalidate stale authority at the controlled write boundary and expose unresolved outside effects.

Contributions bind producer, base revision, artifact and evidence. Review checks that exact version; human acceptance does not automatically merge, publish, send or pay. A reviewer needs usable evidence and a way to request changes. Reuse the existing event/command/recovery model instead of building different truths for browser, API, MCP and integrations.

### Agent initiative and subdelegation

Within a clear standing charter, agents may discover permitted help requests, prepare proposals, read approved context and perform authorized reversible work. New audiences, spending, destructive operations and outward actions require the applicable explicit approval. Future subdelegation needs a bounded grant: children cannot exceed the parent's delegable authority, remaining budget or deadline. The accountable human remains identifiable.

Agents may decline, ask a focused question, return partial progress or stop when the task is no longer worthwhile. Reward reliable contributions rather than endless activity. Discovery exposes only permitted summaries; selecting help does not publish private room history.

## 6. Automation and Dasha: execution without a second workspace

Offer three complementary sources of help: deterministic rules, the user's agents and optional hosted assistance. Rules handle simple reminders/routing without a model. Hosted assistance begins with editable summaries, request clarification and draft replies—not an autonomous executive acting on every conversation.

A routine has a trigger, selected context, allowed changes, limits, expiry and an escalation recipient. Show this compactly at setup; store it precisely underneath. Coalesce duplicate triggers, prevent feedback loops and distinguish last contact from meaningful progress. One status line can replace routine narration, while consequential events remain durable. Linear's session/activity pattern is a useful UI precedent, not authority for our completion state. [Linear agent interaction](https://linear.app/developers/agent-interaction).

Run attempts record dispatch identity, authority, source version, execution environment, limits, checkpoints, output and unresolved effects. Restart or retry reconciles the original attempt. Pause/stop states must reflect what the backend actually confirms. No silent paid overage, credential switching or conversion of a user's subscription quota into promised revenue.

Dasha Compute is an execution/tool adapter, not the room's identity, accounting or task authority. Work on Dasha itself can happen in a dedicated Project Room with selected repositories and people. That collaboration does not merge the separate Dasha, Desk and Demigod codebases or override their ownership rules.

Start with a fake runner, then a local controlled runtime, then a qualified Dasha adapter. Each must expose durable status lookup, deduplication scope, outputs, usage uncertainty and cancellation behavior. Files, diffs, previews and test evidence appear in the same result/detail surface. Do not run arbitrary submitted code inside the messaging service.

## 7. Rewards and a broader opportunity network

### One work item, several kinds of opportunity

| Opportunity | How it fits | Additional requirements |
| --- | --- | --- |
| Code/research contribution bounty | Work item linked to an issue, artifact or reviewed submission | Reproducibility, contributor rights, exact review and acceptance |
| Small online task | Same assignment/result flow for permitted research, testing, document or administrative work | Clear acceptance criteria and consent for outside actions |
| Specialist engagement | Paid preparation, scoped milestones and recurring collaboration | Relevant qualifications, explicitly permitted AI assistance, fair review |
| Real-world task | Human performer with agents assisting planning and coordination | Category/location review, safety, expenses, cancellation and incident support |
| Voluntary help | Unpaid contribution with explicit expectations | Attribution and no implied compensation |
| Work trade | Two linked commitments, with each side's scope and acceptance | Separate policy/reporting review; not an assumed obligation-free payment substitute |

Start with reserved assignments and small curated demand, not default winner-takes-all races. Team contributions need agreed shares before work, not arbitrary retroactive allocation. Reviewer work can itself be compensated. Paid preparation should produce a useful deliverable even when the recommendation is not to proceed.

Add reward attaches a versioned agreement to existing work: sponsor, reward/currency, eligibility, acceptance standard, review window, cancellation/dispute terms, rights and release authority. Material changes require re-agreement. Public publication is a separate sanitized projection with enough detail to assess fit. Joining an opportunity must not reveal the whole room.

A worker can choose in-room, connected-agent, copied-brief or external-tool contribution. Without a callback, show Awaiting update rather than pretending to monitor the external process. Agent identity and the legal recipient of compensation remain separate.

### Money is a parallel lifecycle

John has stated the US-registered Stripe account is the intended ordinary-payment and stablecoin route. That does not establish account readiness or approval. The design separates customer collection, available funds, compensation earned, transfer, payout, refund and dispute. Work acceptance never means paid. Archive or account closure cannot erase outstanding obligations.

Use a dollar-denominated agreement as the initial planning default, with explicit supported payment and payout routes. Keep gross customer amount, agreed worker compensation, fees and settlement distinct. Do not promise protected escrow or a net amount without a supported arrangement. Financial records need reconciliation, role-limited release and an accountable exception owner.

Current Stripe documentation distinguishes stablecoin acceptance, which settles in local currency, from Connect stablecoin payouts, currently a private preview for US platforms with recipient and onboarding restrictions. These require separate readiness checks. This roadmap does not select an exact Connect responsibility configuration, fee rate or live account change. [Stablecoin payments](https://docs.stripe.com/payments/stablecoin-payments), [Connect stablecoin payouts](https://docs.stripe.com/connect/stablecoin-payouts).

The Stripe Connect guidance influenced the requirement to decide fee ownership, negative-balance liability, onboarding, refunds/disputes and payout support before live rewards. The Stripe documentation CLI was unavailable; the official documentation connector supplied the refreshed availability check. No account was inspected. Professional review of the actual business model and task categories remains a launch gate, not a user-interface substitute.

Physical work launches as a separately supervised, narrow category—not a general errands marketplace. Protect location/contact details, permit safe withdrawal, agree expenses beforehand and provide incident escalation. No continuous location surveillance by default. Work-trade infrastructure, pooled rewards and broad public competitions are later candidates rather than hidden requirements for the initial paid pilot.

## 8. Shared architecture and ownership boundaries

| Concept | What it owns | What it must not imply |
| --- | --- | --- |
| Account / member | Identity, membership and accountable sponsorship | Verified vendor/model identity or payment eligibility |
| Conversation / room | Audience, messages, context and discussion | Access to every member's connected account |
| Source / shared excerpt | Origin, version, permitted projection | Ongoing import of the whole source |
| Work / agreement | Outcome, scope, responsibility and terms | Execution or spending authorization by itself |
| Attempt / claim | Bounded activity and current write authority | Guaranteed external termination or isolation |
| Artifact / review / decision | Exact results, checks and acceptance | Delivery, deployment or payout |
| Connection / grant | Approved account/tool route and permissions | A running worker or limitless delegation |
| Routine / dispatch | Triggered activity, limits and recovery | A new task database independent of work |
| Reward / financial records | Amounts, obligations and provider reconciliation | A single trustworthy Paid boolean |

These are conceptual responsibilities. Reuse existing records where their lifecycle matches; create new persistence only where authority, recovery or accounting requires it. Prefer modular domains and adapters within the existing deployment before adding services. Unification means shared contracts, not storing private mail and public work in one unrestricted log.

Room commands remain authoritative for shared work. Providers remain authoritative for their delivery/settlement records. Repositories retain artifact truth. Private inbox storage, credentials and shared projections require separate access enforcement. Every path—browser, agent, connector and automation—uses the same current authorization checks.

Retain source/version provenance, stable operation IDs, replay-safe commands and migration compatibility. Define per-domain deletion, retention, cache and export behavior. Revocation stops future authorized retrieval but cannot erase already exported copies. Prefer isolated artifacts over conflicting outside writes when the destination cannot enforce ownership checks.

## 9. Roadmap: ambitious destination, gated releases

Stages describe dependencies, not promised dates. Work can be prepared in parallel in separate claimed lanes, but release depends on evidence. A delayed messaging adapter must not block useful native collaboration; a stablecoin preview must not block a separately ready ordinary-payment pilot.

| Stage | User-visible outcome | Included scope | Exit evidence |
| --- | --- | --- | --- |
| 0. One dependable baseline | Existing rooms behave predictably | Reconcile local/staging versions, finish offer controls and negotiated context, qualify schema-14 recovery | Current suites, compatibility/race tests and documented release candidate; no claim of live parity without inspection |
| 1. Unified experience prototype | Talk, inspect sample messages and collaborate without navigating a maze | Inbox/Rooms shell, synthetic email/chat side panel, audience-aware composers, request-to-result flow | Desktop/mobile screenshots, keyboard checks, preserved drafts and zero private-to-room leakage in specified tests |
| 2. Real connected collaboration | Use one inbox account and one's own agent | Qualified email adapter, host-specific agent checks, portable return, private sharing, real send receipts | Dedicated account trial with authorization, actual scoped agent contributions, lost-response/revocation recovery |
| 3. Useful assistance and execution | Ask for help and run an explicitly bounded routine | Hosted draft assistance, deterministic rules, attempt records, local runner then Dasha qualification | Zero-credit/manual path, budget-stop, duplicate-dispatch, checkpoint and cancellation drills |
| 4. Paid digital-work pilot | Fund scoped work and receive a reviewed result with accurate payment status | Rewards, eligibility/onboarding, ledger, reviews, release/refund/dispute/payout handling | Provider/business approval, sandbox reconciliation, exception rehearsal and separately authorized limited live pilot |
| 5. Broader messaging and collaboration | Keep more conversations and collaborators in reach | Qualified personal bridge and business/SMS adapters, native private groups, richer media, optional calls if justified | Per-channel compatibility matrix, audience/consent tests and measured transfer friction reduction |
| 6. Opportunity network | Find suitable work or help beyond one's current room | Curated public listings, agent-readable discovery, capability evidence, specialist trials, team work and templates | Moderation/abuse handling, private projection tests, actual accepted contributions and repeat demand |
| 7. Wider real-world coordination | Coordinate approved physical tasks and other exchange models | Narrow physical pilot, separately cleared work trade, pooled or recurring opportunities where justified | Category-specific operating support, safety/payment exceptions and demonstrated demand; no automatic expansion |

Stages 3 and 4 share the authority/recovery foundation but neither requires every feature of the other. Stage 5 adapter research may run alongside earlier development. Public matching needs controlled access and moderation even when no money is involved.

An optional organization track follows demonstrated team demand: centralized identity, organization policies, audit export, retention controls and aggregate execution limits. These extend existing membership and grants rather than replacing them. Enterprise identity/provider selection and data-residency promises require explicit technical qualification; they are not prerequisites for a good small-room experience.

## 10. The next concrete backlog

| ID | Deliverable | Dependency | Done means |
| --- | --- | --- | --- |
| U01 | Current implementation/release inventory | None | One verified map of source, schema, package and environment; historical tests labeled |
| U02 | Finish offer/select/release and context negotiation | U01 | Human and agent paths agree under races, stale state and retries |
| U03 | Compatible recovery package | U01–02 | Recovery rehearsed with matching data and writer rules |
| U04 | Navigation and composer prototype | U01 | Inbox/Rooms, separate internal/external drafts, mobile return and accessible controls |
| U05 | Private messaging domain with synthetic adapter | U01, authority review | No private bodies in shared event projections; stable source/send identity |
| U06 | Message → shared excerpt → work → reviewed reply | U02, U04–05 | One complete synthetic journey including blocked/rejected/unknown states |
| U07 | Agent and manual contribution parity | U02, U06 | Same result accepted through browser, direct/MCP and copied-packet routes |
| U08 | Evidence pack and release decision | U03, U06–07 | Screenshots, logs and actual-agent exercises tied to the exact candidate |
| U09 | Dedicated email qualification | U08 plus account/send authority | Correct account/audience, attachment support, reconciliation and reconnect |
| U10 | Hosted/routine execution specification | U02, U07 | Fake-runner proof, bounded permissions and honest stop/usage semantics |
| U11 | Reward/accounting specification and sandbox | U02, U07 | Accepted terms, earned obligation, exceptions and provider records reconcile |
| U12 | Optional network discovery prototype | U07 plus publication controls | Sanitized opportunity, eligible offer and scoped return without exposing private context |

Start implementation with U01–U08. U10–U12 can be designed against those contracts without enabling paid execution, public publication or live rewards. Source ownership must be claimed before edits; this document does not assign work to other agents or override their lanes.

## 11. Growth, retention and the free experience

Three organic loops support one product:

- Conversation loop: useful people and agents are present; returning is pleasant without an obligation dashboard.
- Work loop: a result is easy to recover, the next request needs less explanation and reviewers can help directly.
- Contribution loop: a well-scoped opportunity brings someone into a useful room, where good work can become an ongoing relationship.

Invites point to a specific room, review or contribution with clear access. Reusable templates strip private data and live grants. Public examples and agent-readable documentation describe real capabilities; they never instruct visiting agents to ignore their owners or consume quota without consent. Recognition records accepted contributions and useful reviews, not token consumption or manufactured activity.

Free should support genuine messaging, manual work and bring-your-own-agent participation within disclosed resource limits. Hosted inference, managed execution, larger storage and operational capacity can support paid plans. No surprise overages. Exhausted credits leave existing results, review, manual completion, disconnect, essential privacy and payment support usable. Subscription charges and transaction fees are separate. Prices and allowances wait for measured costs; no profitability or earnings claims are made here.

Retain the prospective useful-outcome and repeat-work definitions in TWELVE-DECISIONS.md rather than inventing another dashboard. Those evaluate the work loop, not the entire social product. Validate casual messaging separately through observed usability and voluntary return; do not treat a room without work cards as a failed session.

## 12. Quality, operations and release policy

Each release needs functional checks and an evidence pack, not just a screenshot of the happy path. Cover stale authority, duplicate commands, revoked access, lost acknowledgments, altered evidence, abandoned work, failed payment destinations and disconnected providers as applicable. Test native chat without AI, messaging without tasks and work without money.

Browser checks include narrow screens, enlarged text, keyboard-only use, accessible names, focus, composition input, long content and preserved drafts. Inspect screenshots of relevant states. Actual scoped agents test the agent contracts; simulated humans test mechanics and expose hypotheses, not retention or human enjoyment. Later observed participant sessions compare against existing tools rather than a deliberately weak baseline.

Before a live release: authenticated invite-only access, no reliance on an unlinked URL for privacy, backup/restore rehearsal, matching migration/recovery package, secrets/log review, quotas/rate limits, error visibility and a responsible support contact. Public discovery, managed execution and payment each add their own operational gates. An account can request deletion or export without financial obligations disappearing from required operational records; retention rules need explicit review.

For source reuse, retain pinned provenance and license checks. Borrow selected patterns; do not import whole frameworks solely because they are open source. Keep third-party dependency upgrades and adapter conformance independently testable.

Release authorization is separate from product agreement. No current production-readiness claim follows from this blueprint. The named staging domain and proposed trydemigod.com placement remain deployment context, not evidence that this full product is published there.

## 13. Scope control without shrinking the ambition

A proposed feature must answer five questions before entering implementation: which user journey improves, which existing object/surface it extends, what authority it needs, how it fails, and what evidence would justify keeping it. If it requires a parallel identity system, work tracker, generic dashboard or mandatory onboarding detour, redesign it first.

In scope but later: richer collaboration, broad connectors, native private groups, specialized agents, reusable routines, Dasha execution, public opportunities, paid review, stablecoin routes when approved, physical tasks and work trade when cleared. Their existence on the roadmap is not a claim that they are all equally valuable or launchable.

Not default ambitions: a replacement editor for every artifact type, a universal social feed, a token currency, automatic global agent rankings, unlimited recursive agents, surveillance-based worker management, unsupported messaging bridges or a new cloud runtime for every provider. These require separate evidence, not enthusiasm alone.

The product stays unified by sharing conversation, work, result and permission concepts—not by pretending all channels, contributors and payment routes behave identically.

## 14. Source map and planning precedence

This blueprint is the overview. Preserve these supporting documents for evidence and deeper contracts:

- [General design guide](PROJECT-ROOM-DESIGN-GUIDE.md): broader UI/UX research, proposed visual foundations, complete-state design and prototype evaluation practice; supports rather than replaces this roadmap.
- [Research and plan v2](2026-09-07-project-room-v2/report-source.md): economics, collision prevention, automation and operational exceptions; historical implementation states are not current evidence.
- [Collaboration and messaging research](multiplayer-messaging-20260908/report-source.md): academic/product references, adapter boundaries and pinned source reviews.
- [Twelve decisions](multiplayer-messaging-20260908/TWELVE-DECISIONS.md): default choices and prospective work-outcome measurements.
- [Delegation and review](multiplayer-messaging-20260908/DELEGATION-AND-REVIEW.md): targeted failure/interaction tests and research limitations.
- [Quiet product design plan](../docs/QUIET-PRODUCT-DESIGN-PLAN-2026-09-08.md): detailed copy, accessibility, navigation and interaction requirements.
- [Agent workspace roadmap](../docs/AGENT-WORKSPACE-ROADMAP-2026-09-08.md): execution, grants and deeper agent participation.
- [Multi-route bounty design](../docs/BOUNTIES-DESIGN-2026-09-07.md): contribution routes and versioned reward agreements; earlier unresolved collection choices are superseded by John's stated collection/distribution direction, not by presumed account approval.

Older narrow v0 exclusions are sequencing constraints, not permanent prohibitions. New planning should update this entry point with decision changes and link to supporting evidence rather than creating an unrelated competing roadmap. Exact schemas, screen prototypes, channel policies and operational ownership are completed at the relevant milestone before release.
