# Project Room: from research to a unified build plan

September 8, 2026. Planning checkpoint, not release authorization. Implementation began afterward; the [local reader checkpoint](../docs/EMAIL-READER-CHECKPOINT-2026-09-08.md) and subsequent [email excerpt/return checkpoint](../docs/EMAIL-EXCERPT-CHECKPOINT-2026-09-08.md) record implemented subsets and verification. Remaining phases below are plans, not completed capabilities. Neither checkpoint establishes a live mailbox or external sending.

## Executive decision

Build the next iteration around one complete experience: bring a request into a room, let a human or agent contribute, review the exact result, and carry it back to where it is needed. Preserve enough context that another participant can continue later without reconstructing the story.

The ambition remains broad. The implementation should become narrower and more connected. We already have local work-lifecycle and result foundations; introducing another task engine, approval database or agent-specific room model would make the product harder to understand and maintain.

This is a planning synthesis of the [inspiration atlas](PROJECT-ROOM-INSPIRATION-ATLAS-2026-09-08.md), [open decisions](PROJECT-ROOM-OPEN-DECISIONS-2026-09-08.md), fresh research below and targeted inspection of the existing code. Existing implementation checkpoints remain authoritative about what was tested at their particular commits. This document supplies build order, not replacement historical evidence.

## Fresh research: what changes and what does not

### Shared work should survive the agent runtime

CommonGround Kernel's May 2026 preview focuses on preserving requests, handoffs, returned work and recovery context rather than owning every runtime or orchestration strategy. Its current repository describes a small ledger-oriented foundation. This is a close adjacent direction, so we should not claim that durable human–agent collaboration is unique to Project Room. Our proposed distinction is the complete, understandable experience around that foundation. Its shared/public records model must not be interpreted as permission to expose private room content. Reviewed the announcement and repository description, not the implementation or deployment behavior. [Announcement](https://ii.inc/blog/post/cgk-preview), [repository](https://github.com/Intelligent-Internet/CommonGround).

**Planning consequence:** keep durable room facts separate from an agent's temporary execution state. Borrow design ideas, not a second kernel beside our existing one.

### Let structure emerge from ordinary work

Ink & Switch's Embark enriches informal notes with structured references, computations and views. Its authors also report important limitations: collaboration was not the focus, prototype quality affected shared editing, and new users would need better guidance through the data model. It is promising interaction research, not proof of a production-ready multiplayer interface. [Embark](https://www.inkandswitch.com/embark/).

**Planning consequence:** a message can become work, a draft can become a result, and a result can become a reusable example. Each promotion should be an understandable action. Do not automatically convert all conversation into tasks or require a workflow designer at onboarding.

### More concurrent work changes the problem

Microsoft's CORPGEN research studies interleaved tasks, context interference, dependencies and reprioritization. The report describes inspecting output artifacts rather than relying only on screenshots or action logs. Its reported relative improvements coexist with low absolute completion on difficult benchmark settings; this is not evidence that unattended office work is solved. [Research report](https://www.microsoft.com/en-us/research/blog/corpgen-advances-ai-agents-for-real-work/), [paper](https://arxiv.org/abs/2602.14229).

**Planning consequence:** retain screenshots for visual review, but also inspect actual returned artifacts and committed state. Test a small amount of overlapping work before increasing agent concurrency. A busy-looking room is not evidence of progress.

### Shared understanding is a continuing interaction

*Challenges in Human-Agent Communication* identifies questions about goals, preferences, capabilities, upcoming activity, results and side effects. Its common-ground framing concerns operational alignment, not an assertion that agents think like humans. Reviewed its introduction, framework and grounding discussion; it is a research agenda rather than validation of our interface. [Paper](https://www.microsoft.com/en-us/research/wp-content/uploads/2024/12/HCAI_Agents.pdf).

**Planning consequence:** a useful work card answers what is expected, who is acting and what needs attention. Details remain inspectable, but a user should not need to read an execution transcript to establish those facts.

### Stable boundaries can outlast model-specific tricks

Anthropic's April 2026 engineering account separates the session record, agent harness and execution environment. Its older effective-agents guidance advocates simple composable approaches and now explicitly notes that the tooling landscape has changed. These are vendor engineering accounts, not guarantees or reasons to select a paid provider today. [Managed-agent architecture](https://www.anthropic.com/engineering/managed-agents), [earlier design guidance](https://www.anthropic.com/engineering/building-effective-agents).

**Planning consequence:** use adapters for execution and tools. Do not hardcode today's model behavior into the permanent room model. Provision an execution environment only when a task needs one; preserve artifacts and accountable state independently.

### Ownership matters even if we do not rebuild as local-first

Ink & Switch's local-first work emphasizes offline operation, longevity and user control of creative data. It does not claim that all domains, including financial transactions, should abandon centralized authority. [Local-first paper](https://www.inkandswitch.com/essay/local-first/).

**Planning consequence:** improve draft resilience, export and recovery within the existing architecture. A whole-product CRDT rewrite is not justified by this research. Shared editing, work ownership and external action authorization remain different problems.

## Grounding the plan in the current project

At the planning baseline, the checkout inspected was `work/project-room-unified-20260907`, clean at `69bef95`. No tests had yet been run for this plan. Historical test counts below are intentionally not presented as current-run results; subsequent implementation verification belongs to the linked reader checkpoint. The latest live deployment was not inspected.

| Area | Evidence inspected | Consequence |
| --- | --- | --- |
| Agent lifecycle | `docs/AGENT-WORK-LIFECYCLE-CHECKPOINT-2026-09-08.md` records local propose/accept/claim/start/block/complete/review paths and actual short agent participation | Reuse the lifecycle; check current coverage before adding another concept |
| Exact text results | `docs/NATIVE-TEXT-RESULT-CHECKPOINT-2026-09-08.md` records version-bound text results and independent review | Do not design result acceptance as if nothing exists |
| Durable email | `docs/EMAIL-IMPORT-CHECKPOINT-2026-09-08.md` records account-owned fixture import, retained drafts and migration/recovery checks | Treat this as local storage groundwork, not a connected mailbox |
| Offline synchronization | `server/graph-fixture-sync.mjs` was inspected directly; it requires a recorded mailbox reader and separates prepare from apply | Keep fixture transport distinct from any future network driver |
| Browser Inbox | `src/inbox-client.js` was inspected directly; selected-source and send-envelope validation currently require the synthetic adapter | Negotiate bounded email support deliberately; do not simply remove validation |
| Existing roadmap | `docs/AGENT-WORKSPACE-ROADMAP-2026-09-08.md` already separates charters, attempts, execution and tools | Reconcile with that roadmap rather than create a competing agent architecture |

Some older roadmap entries precede newer checkpoints. Before implementation, map each proposed change to current code and tests and mark it existing, incomplete or absent. A plan's future-tense wording is not proof that a capability is still missing.

## Product shape: three understandable surfaces

**Inbox:** what arrived, what needs me, and drafts I can continue. Private account sources stay private unless deliberately shared.

**Room:** conversation around a purpose, with current work and results visible in context. No requirement to name every message as a task.

**Work detail:** the selected request, owner, result, review and relevant history. Advanced tool, connection and attempt information expands here or under the existing participant controls.

These are responsibilities, not necessarily three new navigation destinations. Keep existing Inbox/Rooms navigation. Do not add permanent tabs for research, bounties, agents, automation, decisions and every future artifact type.

Example progression: someone shares a selected passage and asks for a draft. An existing work item records the assignment. A contributor returns the draft. The reviewer sees the exact text and outstanding issues. The requester adopts it into their private reply draft. A later sketch or funded task follows the same contribution pattern where appropriate, without pretending that all artifact types have identical requirements.

## Architecture decisions to keep

1. **One authoritative work lifecycle.** Human UI, API, MCP and portable contributions use the same domain operations and permissions.
2. **Separate private sources from room context.** An agent's room access does not grant mailbox access. Share selected material with an explicit audience.
3. **Separate result acceptance from external effects.** A reviewed draft does not imply permission to send, publish, deploy or pay.
4. **Separate durable facts from transient summaries.** Summaries can be regenerated or corrected without rewriting accepted results or policy.
5. **Capabilities are explicit.** Describe what a connection supports and what this participant may do. Hide unsupported actions without concealing important limitations.
6. **Manual and external contributions remain legitimate.** Preserve provenance honestly; a pasted answer is not falsely attributed to a verified provider.
7. **Use the smallest effective execution strategy.** A single worker is valid; parallel specialists must have independent useful work or a clear review role.

These are design constraints to verify against the current implementation, not an instruction to add seven new abstractions.

## Phased implementation plan

### Phase 0 — Consolidate the baseline

**Goal:** avoid rebuilding existing features or confusing local evidence with live behavior.

- Reconcile the current lifecycle, Inbox, result and connection code with the latest checkpoints.
- Record one current capability inventory, including local-only and unsupported states.
- Locate the exact regression commands and retained release/recovery evidence for the current runtime.
- Select the first fixture journey and name its success criteria before editing.

**Exit:** every proposed change in Phase 1 has a named existing owner/module and a test location. If a behavior already works, retain and test it rather than inventing a replacement.

### Phase 1 — Make the email foundation usable in the existing Inbox

**Goal:** read bounded plain-text fixture email, preserve a draft and share only the chosen context.

**Edit points identified during planning:** `src/inbox-client.js`, `src/inbox-ui.js`, `server/inbox.mjs`, and existing Inbox/email tests. Subsequent checkpoints record the reader and exact plain-text excerpt sharing with reviewed private-draft return. HTML, attachments and live-provider work remain separate incomplete capabilities.

- Define explicit supported source types and returned capability information with strict validation.
- Preserve synthetic-source compatibility and account/session checks.
- Render plain text without executing embedded content or fetching remote resources.
- Display source-change and connection-state information only where it affects the next action.
- Keep real sending unavailable unless a separate tested and authorized transport is introduced.
- Exercise exact excerpt sharing using current room-audience checks; do not silently include surrounding private messages.

**Exit:** an imported fixture can be read in the existing Inbox, edited into a draft, reopened after restart and shared by selected excerpt. A different room member cannot read the private source. Source changes and disconnects do not silently discard the draft.

**Stop condition:** if supporting another source requires bypassing current validation or weakening privacy, finish the contract first. A visually complete inbox is not a reason to accept ambiguous source identity.

### Phase 2 — Complete the source-to-room-to-result loop

**Goal:** a useful result moves through existing work and review controls and returns to the requester.

**Likely edit points:** existing result operations in `server/text-results.mjs`, lifecycle operations in `client/work-actions.mjs`, Inbox result adoption and the existing journey fixtures. Change only demonstrated gaps.

- Use existing assignment, claim and review semantics.
- Provide just enough context for a contributor to begin without re-reading unrelated room history.
- Preserve the exact reviewed result and its source basis when adopted into a reply draft.
- Make revision, supersession and stale-source states clear in the existing work detail.
- Preserve a manual contributor path with the same acceptance requirements and honest attribution.

**Exit:** one producer and one independently acting reviewer can finish a bounded writing task; the requester can inspect and adopt the accepted text. An old review does not approve revised text. No external message is sent merely because the result was accepted.

**Stop condition:** if agent participation depends on the coordinator relaying every answer or supplying the reviewer verdict, the collaboration test is incomplete.

### Phase 3 — Make interruption and return feel reliable

**Goal:** leaving the product does not destroy context or require scrolling through every update.

- Build on existing attention and watcher mechanisms, after checking their current coverage.
- Present the current owner, blocker and next useful action without duplicating the event stream.
- Keep human read state distinct from an agent fetching context.
- Give a returning contributor a compact, source-linked handoff, not a fresh unrestricted context dump.
- Group ordinary progress; surface direct questions and blocking decisions.
- Test a small overlapping-work scenario and a delayed response, not only a straight-line demonstration.

**Exit:** after an interruption, the next participant can determine what is current, continue the right work and avoid repeating a completed action. Old observations cannot quietly replace current ownership.

**Stop condition:** do not add a new scheduling engine to compensate for an unclear work state. Fix the state and handoff first.

### Phase 4 — Add one replaceable execution adapter

**Goal:** an authorized agent can use a bounded work environment while the room remains the record of accountability.

- Begin with a deterministic fake runner and explicit attempt identity.
- Exercise start, progress, artifact return, lost acknowledgements, reconnect and cancellation outcomes.
- Keep credentials and granting authority separate from generated work.
- Connect a real local or hosted provider only after the contract passes and current authority permits it.
- Keep Dasha Compute a separately scoped tool-provider candidate; do not merge product state or branding.

**Exit:** replacing or interrupting the runner does not lose the accepted work record or silently duplicate dispatch. No claim of isolation is made for separate directories under a single shared OS account.

**Stop condition:** do not start paid execution, provision accounts or broaden grants as part of routine fixture testing.

### Phase 5 — Expand contribution and usefulness

**Goal:** make successful work reusable and easier to contribute to without overwhelming the default interface.

- Choose one artifact extension, such as a reference collection or sketch, based on the first journey that needs it.
- Improve portable work packets and returned-result review before promising every vendor a native integration.
- Offer explicitly prepared, privacy-reviewed examples or templates for sharing.
- Test task-scoped invitations that let a new participant make one useful contribution with little setup.
- Keep hosted AI optional; preserve useful manual and compatible bring-your-own-agent workflows within disclosed limits.

**Exit:** the added capability improves a concrete existing journey and does not require another permanent product area.

**Separate later gate:** paid bounties, collection/distribution, stablecoins, disputes and reciprocal-credit systems require their own payment, policy and operational work. They are not authorized or resolved by this plan.

## Verification plan

Every implemented slice needs four kinds of evidence: a successful journey, a failure/recovery journey, an authority-boundary check and visual inspection. Reuse existing tests wherever possible.

| Scenario | What must be demonstrated |
| --- | --- |
| First arrival | A useful draft or contribution without mandatory integration setup |
| Selected sharing | Only previewed content reaches the selected room audience |
| Source changes | Changed input is visible before old work is adopted or acted upon |
| Two workers | A clean refusal/handoff or intentional comparison, not accidental duplicate execution |
| Reviewer correction | Rework targets a new exact result; acceptance does not transfer automatically |
| Restart | Stored drafts, result versions and action receipts remain consistent |
| Cancellation | Requested stop, confirmed stop and already-completed effects are not conflated |
| Account or grant change | Old responses and requests cannot silently continue under new authority |
| External contributor | A portable return is reviewable without overstated provenance |
| Visual simplicity | Common actions are discoverable; important state is not hidden to reduce words |

Capture screenshots for arrival, selected sharing, work in progress, result review and return after interruption on desktop and a narrow viewport. Also inspect exact artifact contents and resulting work state. A screenshot of a passed-looking screen is not proof of correct data or permissions.

Actual agents should choose and perform their own bounded actions when that test is authorized. Scripted clients verify protocol mechanics but are not a substitute for semantic agent participation. Human simulations remain useful design checks; they do not prove human satisfaction, comprehension or retention. No new tests or screenshots were produced in this research turn.

## Questions that remain genuinely open

- Does the best first audience need recurring team rooms or short-lived project rooms? Start with temporary, purpose-driven work as a hypothesis, not a market conclusion.
- Is the most valuable return experience a compact brief, pending decisions or the latest artifact? Prototype these around the same data before adding multiple overview screens.
- How much context can a contributor omit without losing correctness? Keep selected sources available and inspect omissions rather than trusting summary length alone.
- When is a second reviewer worth the delay? Test tasks where review has a distinct purpose, not a universal double-check ritual.
- Which artifact should become reusable? Promote reviewed examples deliberately; do not turn every agent draft into shared memory.
- What evidence would justify adding another channel? A clear user journey, a supportable provider contract and repeatable integration tests—not popularity alone.

## Scope discipline and next action

No calendar estimates are asserted before implementation gaps are measured. Each phase should end with a usable checkpoint, exact evidence and an explicit list of unsupported behavior. If a phase grows into a second product, reduce its scope.

The immediate next build candidate is **negotiated, fixture-backed plain-text email in the existing Inbox**, followed by the already-designed result-return journey. That connects current foundations to visible usefulness. It is a stronger next step than another generalized agent framework, new sidebar section or public marketplace.

The longer-term product can still support messaging, collaborative creation, agent execution and rewarded contributions. Its unity should come from a consistent request, contribution, review and result experience—not from making every feature look like a chat message or putting every tool on the home screen.
