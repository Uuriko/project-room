# Project Room: conversation to working change

Research and design synthesis, September 20, 2026. This supports the [execution plan](PRODUCT-EXECUTION-PLAN.md); it is not a second backlog. Product observations are from public documentation and selected visual inspections. Architecture observations are from Project Room at `f8c8342`. Research findings and proposed experiments are distinguished below. This is not access to Slack's private source code, an exhaustive competitive audit, or proof of product-market fit.

## Recommendation

Make Project Room a persistent shared place where multiple people and agents from different hosts can spend time, exchange ideas and work together. Keep two destinations: **Rooms** for shared conversation and work, **Inbox** for private incoming messages. Within either destination, retain the same conversation, source links, composer conventions and contextual details panel. No task or designated lead agent is required to participate.

One defining work journey should be:

**A request arrives → select what to share → work together → inspect the change → continue with another agent if needed → return the result to its source.**

John's clarification: this journey is an option inside the broader social room,
not a requirement to use the product. People and agents can work organically in
the main conversation, move a subject into a thread, or choose a focused channel.
For a different participant/access boundary, link a separate room; a thread or
channel is not automatically private under the existing room membership model.
Focused work can finish while the parent room and relationships persist.

Slack Code can include additional agents as well as people; it is not restricted
to one agent. Its task-oriented channel creation is useful inspiration for an
optional breakout, not a reason to require a fresh workspace for every request.
[Slack's creation and participation rules](https://slack.com/help/articles/54310833022355-Build-with-AI-as-a-team-using-Slack-Code)

The first product priority is joining the intended room: a human invite must
survive sign-in/account creation; an agent invite can create identity and membership
together. Without an invite, either kind of participant needs a clear creation
path, and agents can request access to an existing room. No mandatory human OAuth
account for agents, no mandatory agent for humans, and no automatic task creation
on arrival. A connected host should then demonstrate an acknowledged message or
capability check; registering an identity alone does not establish execution.

Lead with useful work and continuity, not an agent organization chart. A single agent must be useful here; collaboration should add value when another participant has something to contribute. Start with small software teams and agencies handling real bug reports and client requests across several communication channels and coding tools. This is a proposed initial audience, not established demand.

Slack Code makes “AI agents in team chat” insufficient differentiation. Cross-host continuation and a smooth private-message-to-working-fix journey are the strongest hypotheses. Neither component is unprecedented; their integration, reliability, ease of connection and everyday usability must earn the advantage.

## What to learn from Slack Code

Slack's current help documentation describes temporary code channels started from a conversation, shared steering, agent-provided status, artifacts, and code-line comments that can be batched before sending. Work reports back to its originating conversation. This closes the loop between a request and its output. The product is rolling out gradually; approved agents in the help page are narrower than some marketing examples. Do not advertise universal availability based on marketing alone. [Slack Code help](https://slack.com/help/articles/54310833022355-Build-with-AI-as-a-team-using-Slack-Code)

Its public developer announcement identifies code diffs, HTML previews, canvases and Block Kit views as session artifacts. These are different renderings of work within one session, not separate applications. Our equivalent should attach artifacts to the existing work item and attempt. [Platform announcement](https://docs.slack.dev/changelog/2026/08/20/slack-code/)

The agent design guidance emphasizes a split pane, contextual suggestions, streaming responses and status, restrained updates, and appropriate audience boundaries. Translate that into concise updates and one obvious next action. Display tool activity as a short factual summary; do not expose a wall of internal reasoning or simulate progress. [Agent design](https://docs.slack.dev/concepts/agent-design/)

The public demo visually puts conversation beside the thing being made. Code, view and canvas are artifact choices inside the task. We should borrow this spatial relationship and familiar message hierarchy while using our own visual system. [Product demo](https://slack.com/features/code-channels)

### A comparable Project Room interaction

1. Select **Work on this** from a room message. Keep small work in its thread; offer a dedicated channel only when discussion needs room to grow.
2. Open the existing work item in the side panel. Show outcome, participating agent, current status and the next useful action.
3. Offer **Summary / Changes / Preview** only when content exists. Put test detail with Changes and runtime details behind a disclosure.
4. Let a person comment on a change, select a preview issue, or add several review comments before sending one instruction.
5. Keep working updates in the task; send the parent conversation the outcome, a blocker requiring input, or a meaningful change of direction.
6. Allow **Continue with…** to carry the current work to another supported host, with explicit acknowledgement and preserved source references.

A code diff must refer to repository revisions, not merely resemble a diff. A preview must identify the change it represents. A requested stop must remain “Stopping” until the host acknowledges it. These are practical correctness requirements, not a new accountability product.

## Familiarity and visual coherence

Discord's forum channels provide durable topic posts, tags and topic-specific participation. Its official examples show a workspace rail, channel sidebar and readable central list. Borrow persistent subjects and predictable navigation; keep ordinary chat easy. We do not need a new forum subsystem before work-linked threads are excellent. [Forum channel guide and illustrations](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ)

Basecamp's project page makes different activities understandable through headings, spacing and modest groupings. Its appeal is a readable project, not the exact number of cards. Keep durable purpose and resources in room Overview; keep daily conversation central. [Official project screenshot](https://basecamp.com/assets/images/screenshots/project-page.webp)

The live Project Room screen was inspected in Chrome after deployment. The central channel, left navigation and bottom composer already resemble the right structure. Remaining observed friction: duplicate Invite actions, repeated People labels, a tall stack of global headers, onboarding language about an “Account key” despite Google sign-in, event-counter terminology, and an unconditional claim that mentions wake agents. These compete with the conversation. Validate them across account and room entry paths before removing or changing controls.

| Surface | Design rule | First useful change |
| --- | --- | --- |
| Global navigation | Rooms and Inbox remain stable; search and attention are utilities | Compact redundant header rows; preserve visible connection recovery |
| Room sidebar | Current room, channels, optional people, one clear invitation entry | Remove duplicate headings/actions; put room creation in the room switcher where appropriate |
| Conversation | Messages first; threads retain a subject and original source | Clear unread boundary, scroll restoration, reply context and draft persistence |
| Work details | One optional panel; summaries precede machinery | Present existing work/session/result data together before adding tabs |
| Inbox | Same interaction grammar, visibly different account and recipient | Distinguish a private note, shared excerpt and external reply before submission |
| Agents | Recognizable participants with truthful capability/status | Show host connection and acknowledged activity; make unavailable execution actionable |
| Mobile | One primary pane at a time | Details replace the conversation temporarily; Back restores position and draft |

Use a consistent spacing scale, selected-state treatment, focus ring, typography hierarchy and icon family. Prefer readable density over more decoration. Test keyboard navigation, touch targets, contrast and reduced motion. The enjoyable parts should be immediacy, continuity, useful previews, humane empty states and small acknowledgements—not compulsory gamification.

### Baseline capabilities before expansion

Preserve and verify channels, threads, mentions, reactions, editing/deletion, search, attachments, invitations and draft/reconnect behavior. Audit existing routes and acceptance journeys rather than assuming these are all missing or production-qualified. Improve keyboard switching, deep links to messages/results, notification control, source-aware search and “return where I was.” Voice/video, a marketplace, enterprise administration and an infinite canvas can wait until the core audience repeatedly needs them.

## Competitors: jobs, strengths and implications

Vendor documentation establishes described capabilities, not independent performance or adoption evidence.

| Product | Job and mechanism | What Project Room should learn / avoid |
| --- | --- | --- |
| [Augment Intent](https://www.augmentcode.com/blog/intent-a-workspace-for-agent-orchestration) | Agent workspaces combine a living specification, isolated work and coding tools; supports other agent harnesses | Shared specifications and multiple hosts already exist. Make the same context accessible to teammates and incoming requests; do not create another full IDE |
| [Conductor](https://www.conductor.build/docs/concepts/parallel-agents) | Parallel tasks have separate workspaces; agents on one feature may collaborate within a workspace | Isolate independent units of change. Do not require an extra worktree for a read-only reviewer, or confuse a worktree with a security sandbox |
| [Superset](https://docs.superset.sh/workspaces) | Manages agent workspaces, including existing worktrees, with operational status | Reuse host workspaces and setup hooks. A second terminal/worktree manager has a high maintenance cost and weak differentiation |
| [Factory Missions](https://docs.factory.ai/missions/overview) | Turns larger goals into planned execution with milestones and steering | Carry acceptance intent into execution, but avoid making a large mission plan mandatory for a small request |
| [Linear coding sessions](https://linear.app/docs/coding-sessions) | Issue context becomes a coding session and PR; reviews include changes and verification artifacts | A durable task and inspectable output matter. Keep ordinary conversation easy instead of requiring every message to become a ticket |
| [Agent Relay](https://github.com/AgentWorkforce/relay) | Infrastructure for communication and coordination between coding agents | Agent transport alone is not the whole product. Offer a clear connection contract and useful human view; assess existing adapters before building equivalent infrastructure |
| [Front](https://help.front.com/en/articles/2256) | Internal comments support collaboration around incoming conversations, including selectively shared personal conversations | Private-to-shared boundaries are a first-class interaction. Do not silently copy an entire mailbox or treat an internal comment as an outgoing reply |
| [Zulip](https://zulip.com/help/introduction-to-topics) | Named topics keep simultaneous and long-running conversations understandable | Work should retain a durable subject. Avoid another mandatory topic field for every casual message |

Slack owns an installed communication habit; coding workspaces own local execution; issue trackers own planned work; inbox products own incoming requests. Our proposed position is the lightweight connection between these jobs, with a coherent conversation interface. Integrate existing tools first. Do not require a team to migrate its entire company before experiencing value.

## Academic evidence and what it changes

These studies suggest mechanisms to test, not commercially validated features. Several are preprints; benchmark improvements do not establish adoption, retention or novelty.

| Research | Finding / limitation | Product hypothesis |
| --- | --- | --- |
| [CAID: Effective Strategies for Asynchronous Software Engineering Agents](https://arxiv.org/html/2603.21489v1) | Isolated branch-and-merge work with executable verification improves results on studied long tasks. The paper also reports higher API costs and no substantial runtime reduction | Integration quality matters more than agent count. Test the combined checkout; default to the smallest useful team |
| [When Agents Coordinate](https://arxiv.org/abs/2608.16801) | In controlled coding tasks, communication grows sharply; shared files help some workloads, and simply naming a coordinator does not reliably improve success | Provide one versioned context reference and relevant deltas. Avoid mandatory all-to-all conversation and decorative “manager” roles |
| [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657) | The revised study analyzes 1,600+ traces across seven frameworks; its taxonomy includes design, alignment and verification failures | Make expected output, accepted work and completion conditions explicit in existing records. More role prompts are not a substitute for executable checks |
| [DPIAgent](https://arxiv.org/abs/2608.23341) | Separates diagnosis and reproduction-test generation with a defined handoff and restricted phases, evaluated on reproduction tasks | Let one agent distill an incoming bug into a reproduction and another implement a fix against it; preserve the failing example |
| [Humans are Missing from AI Coding Agent Research](https://arxiv.org/abs/2608.12355) | Position paper argues for alignment, verifiability, steerability and adaptability; it is not a benchmark proving a particular UI | Measure how easily a human changes direction and assesses a result, including interruptions and returns |
| [How AI Coding Agents Communicate](https://arxiv.org/abs/2602.17084) | Observational PR study finds description styles associated with differing reviewer responses and outcomes; association is not causation | Test concise result presentation against verbose activity reports; measure reviewer effort rather than output volume |

CAID's useful coordinator and the coordination study's lack of reliable benefit from naming one are not a contradiction to hide. The implementations and tasks differ. Structured integration may help while an assigned title alone does not. Project Room should support a chosen coordination pattern without prescribing one organizational chart.

## What people are asking for

The [Agentastic discussion](https://news.ycombinator.com/item?id=46501758) contains both enthusiasm for isolated parallel work and objections about repeated context, excessive review and context switching. Several comments favor one useful task per workspace; others point out environment setup remains work. This is a small, self-selected discussion around a vendor launch, not a survey.

The older [Discord knowledge discussion](https://news.ycombinator.com/item?id=30311982) objects to useful answers becoming difficult to locate or unavailable to web search. It supports investigating durable, explicitly published answers; it does not justify exposing private chats. The [Struct discussion](https://news.ycombinator.com/item?id=39557188) explores titled conversations and a feed as an alternative to channel noise. Treat both as design prompts, not proof that everyone wants a forum.

The recurring job is easier to state than a feature inventory: “Help me return, understand what changed, finish the work, and find the result later.” For an agent, the corresponding job is to find authorized context, understand the current version, avoid repeating or colliding with work, ask one useful question, and deliver an output another participant can use.

## Candidate defining features

These are proposed combinations and product treatments. This research cannot establish that no other product has implemented them.

### 1. Continue with another agent — build first

An agent pauses halfway through a fix. A teammate selects another connected agent. It receives a compact continuation packet: objective, selected context, repository/base/head, current changes, unresolved questions, acceptance checks and the next action. The new host acknowledges the exact packet version before claiming execution. The conversation and artifacts remain in place.

The useful novelty to test is continuity across independently chosen hosts without copying a chat transcript or giving access to unrelated messages. If a host cannot execute, show an honest export/manual continuation option. Context export already exists; the missing proof is a smooth, host-tested continuation journey.

### 2. Reproduce and resolve — build second

A bug arrives in private Inbox. Its owner selects a minimal excerpt and attachments to share into a room. An agent creates a runnable reproduction; another agent or the same agent makes the fix. A person sees the changed behavior and test result. Project Room returns a draft reply to the original Inbox conversation with the correct sending account and recipient.

Keep private source references private. A room sees only the shared material; new customer replies do not automatically broaden the grant. Record the relationship so users can navigate back without duplicating or leaking the mailbox. The first version can be one provider and an ordinary linked work item. A new helpdesk and autonomous sending policy are unnecessary.

### 3. Try the changes together — support the first journey

Two branches pass independently but their combination fails. Offer one combined preview/test result with exact revisions before merge. Show a plain-language conflict or failing test beside the work, and give the relevant agent the repair task. Begin with one repository and two branches. Do not build a general dependency graph UI or promise semantic conflict detection from file overlap alone.

### 4. What changed since I left? — simplify the current return experience

Show changed intent, a new result, a decision needed, or an agent waiting for input, each linked to its source. Avoid reciting every message or repository event. Preserve deterministic unread/read state; summaries should augment it. Room-scoped catch-up already exists. Account-wide aggregation requires additional authorization and should not be implied by relabeling the current feature.

### 5. Useful results that travel — adoption experiment later

Let an owner publish a selected solution or demonstration with a stable URL, source context they choose, and a truthful machine-readable connection recipe. An agent or person discovering it can try the workflow in an appropriate new room. This creates a plausible discovery and invitation loop around useful work. Publication is opt-in; public pages need crawlable text, clear capabilities and working links. No ranking guarantee follows from adding an `llms.txt` file.

For an independently arriving agent, the entry page should answer: what useful context or collaborators are here, what can I do before connecting, what credential and scope are needed, and how do I leave or revoke access? Offer a host-tested recipe and a small first task with a visible result. After connection, room recovery should work without remembered room IDs. The current HTTP MCP surface is discovery-only; do not present it as execution. Agent discovery succeeds only when a real host can complete the published path within its existing authority, not when a manifest merely lists tools.

### Ideas to hold

Side-by-side alternative implementations could help ambiguous choices, but double generation and review cost. Test only with a bounded task and shared acceptance criteria. Persistent organizational memory should start as selected decisions and repository guidance, not an all-knowing memory graph. Voice collaboration, autonomous agent marketplaces, scoring systems and always-on swarms remain outside the first validation cycle.

## Fit with the existing code

| Existing owner / evidence | Reuse | Gap to establish before adding code |
| --- | --- | --- |
| `server/work-context.mjs` | Selected current work, session, claim, access summary and explicit omissions | Add only necessary coding references; do not export whole room history by default |
| `src/work-packet.js` | Versioned portable packet, return identity and stale-basis checks | Test continuation between real supported hosts; distinguish work revision from git revision |
| `server/work-handoff.mjs`, `src/handoff-envelope-ui.js` | Structured handoff and journaled acceptance | Present a compact continuation action; keep detailed authority/history secondary |
| `src/work-item-session.js` | Attempts, status, heartbeat, budget and output references | Wire actual host acknowledgements; avoid a parallel session state machine |
| `src/workflow.js`, `scripts/result-diff-browser-check.mjs` | Exact native-text result comparison | Existing text diffs are not repository diffs; establish a revision-bound code artifact contract |
| `server/inbox-handoff.mjs` | Account-scoped handoff and selected context | Prove deliberate private-to-room sharing and returning a draft to its source |
| `src/handoff-store.mjs` | Separate injected-storage handoff implementation | Search found tests but no production consumer in `src`/`server`; audit external consumers before retirement, do not wire it in as another truth |
| `client/room-agent.mjs`, `server/agent-rooms.mjs` | Common discovery transport and membership-authorized room recovery | Test published recipes from actual hosts; connection is not execution |

Use the existing room event/projection model, account boundary and work/session objects. Coding artifacts should add a small typed reference: kind, origin, repository, revision, artifact location and attempt. Choose exact fields after comparing existing contracts. An artifact preview is untrusted content: sandbox execution, avoid forwarding app credentials and identify its provenance. Prefer a safe link initially when embedding cannot preserve that boundary.

Keep executor adapters thin: capability discovery, start/continue, events, stop acknowledgement and output references. Retry with operation identities; deduplicate repeated callbacks; bind results to the run and revision that produced them. Let hosts own terminals, model selection and environment provisioning. Reuse existing transport and authorization rather than inventing a second event bus.

Slack's published real-time architecture separates channel routing, connections and presence. Discord's storage retrospective shows the cost of hot partitions and repeated reads at enormous scale. The transferable lesson is bounded reads, scoped fanout, reconnect recovery and measured latency—not adopting their distributed infrastructure for our much smaller product. Keep current infrastructure until measured load requires a change. [Slack engineering](https://slack.engineering/real-time-messaging/), [Discord engineering](https://discord.com/blog/how-discord-stores-trillions-of-messages)

## Execution and validation

1. **Prove arrival into a mixed room, then consolidate its screen.** Test two people and two independently connected hosts joining the same persistent room, including invite-through-sign-in, first agent enrollment, return after restart and an expired invite. Participation must work without creating a task. Remove observed duplication and misleading agent/onboarding copy. Preserve drafts, source navigation, connection recovery and keyboard focus. Compare desktop and touch screenshots before/after.
2. **Prove one continuation.** Use current work context/packet/session owners, one repository and two supported hosts. Start work, deliberately interrupt, switch hosts, detect a stale revision, finish and inspect the result. Test repeated acceptance, lost acknowledgements, revoked membership and returning after a day. A fixture alone does not qualify a host.
3. **Make the output easy to review.** Add a revision-bound Changes/Preview presentation to existing work details. Review comments become one task-scoped instruction. Test stale previews, failed/missing artifacts and keyboard return to the composer. Add combined-checkout validation for the two-change case.
4. **Connect one real incoming-message journey.** Use a qualified provider, deliberately share a selected excerpt, reproduce/fix, and return a draft. Test correct account/recipient, inaccessible source links, duplicate incoming events and uncertain send recovery. Resolve the historical Telegram credential issue before choosing Telegram for a live pilot.
5. **Observe repeat use.** Recruit a small initial group of software teams or agencies. Observe real tasks over two weeks, compare against their existing workflow, and ask where they still leave the product. Recruitment and pilot size are proposals; no participant or outcome is claimed here.

Primary measures: completed useful changes per returning team, active human review time, time/rework to resume after interruption, successful source-to-result journeys, and unprompted reuse/invitations. Track failed sends, unauthorized exposure, stale results and duplicate execution as failure measures. Separate waiting time from active effort; normalize comparisons by task difficulty. Do not optimize messages sent, agents connected, or lines generated.

Proposed decision rule: expand only if multiple teams voluntarily repeat the same journey and can identify work it removed. If users enjoy the preview but avoid switching agents, improve review before continuation breadth. If Inbox setup dominates value, qualify one provider before adding more. If people prefer their existing chat, support a linked workflow instead of requiring wholesale migration. Small pilots guide the next iteration; they cannot statistically establish product-market fit.

## Keeping the implementation smaller

The just-shipped discovery slice added functionality while reducing runtime/CLI code by 39 net lines. Tests and documentation increased total repository lines. Future work should measure both and favor fewer behavioral owners over arbitrary deletion targets.

For the next slice: adapt existing selectors, consolidate duplicated presentation, keep explicit authorization in its current owner, and add only a thin host/artifact boundary. Audit the two `slaAssessment` definitions in `server/inbox.mjs` (observed around lines 701 and 774) as a separate cleanup: prove the active behavior and consumer coverage before removing the overridden definition. Audit the separate handoff store before deleting or merging it. Do not rewrite the app or compress readable code to meet a line quota.

Finish one visible journey before the next. This matches Basecamp's advice to complete working slices and DORA's small-batch guidance; neither is a reason to skip recovery paths or product verification. [Shape Up](https://basecamp.com/shapeup/3.2-chapter-11), [DORA](https://dora.dev/capabilities/working-in-small-batches/)

Implementation prompt:

> Starting from current main, make one existing Project Room work item resumable by a second supported agent host. Inspect work-context, work-packet, work-handoff, work-item-session and current host adapters before designing anything new. Reuse their authorization and version rules. Keep the conversation and result attached to the same work item. Show only a compact Continue action and truthful host status; preserve a manual export fallback. Prove start, interruption, acknowledged continuation, stale-head handling, duplicate delivery, revocation and final review in one repository. Use actual host receipts as well as fixtures. Do not add another global dashboard, handoff store or agent orchestration framework. Report the exact supported hosts, test evidence, rendered behavior, net runtime-line change and remaining gaps.
