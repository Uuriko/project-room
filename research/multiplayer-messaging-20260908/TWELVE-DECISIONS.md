# Project Room: twelve decisions

September 8, 2026. Research-backed design review and proposed implementation baseline.

This document resolves the twelve synthesized questions rather than adding another question bank. The dialogue is a constructed review between two product perspectives, not a transcript of private reasoning. Decisions are recommendations; product documentation supplies precedents, research supplies constraints, and neither proves demand for Project Room. No runtime changes, deployment, account connections or spending were performed for this document.

## Position

Project Room helps a person turn a request into a useful, reviewed result with people and agents using their existing tools. The room is the shared record of the work, not a demand to move every conversation, account and application into a new platform.

The first complete journey is: paste a request and selected context → agree on a result → contribute a draft → review → accept a version → copy or download it. Connected delivery follows once this works reliably. Initial audience: individuals and small teams already coordinating work with AI. Public labor-market discovery, payments and an all-channel inbox remain expansion paths, not onboarding requirements.

## 1. What is the first outcome someone should accomplish?

**Product:** A user brings a messy request and leaves with something usable: a response, brief, plan or small change.

**Reviewer:** That could describe any chat application. Why use a room?

**Decision:** Start with a request-to-reviewed-deliverable workflow where context, ownership and review matter. Our reference test is a client request becoming a source-grounded response draft, reviewed by another participant and accepted by the requester. No connected mailbox is required. The differentiator is an understandable agreement, accountable contribution and accepted version—not additional generated text.

For simple questions, ordinary conversation stays ordinary. Do not force room machinery onto a one-message answer. Linear's separate intake workflow supports the distinction between an incoming request and committed work; it does not establish demand for our chosen audience. [Linear Triage](https://linear.app/docs/triage).

**Validation:** Compare this journey with a chat-and-copy baseline using the same task, context and review standard. Measure completed useful results and coordination burden, not apparent sophistication.

## 2. What belongs in a room—and what stays outside?

**Product:** All useful project context belongs together.

**Reviewer:** A useful email may also contain information that nobody else in the room should see.

**Decision:** A room contains deliberately shared context, conversation, work agreements, decisions and artifacts. Personal inboxes, credentials and private preparation remain outside. Adding a source means selecting the material and audience; linking an account never imports its contents into room-wide visibility automatically.

Use private drafts instead of inventing a second complex workspace. Let rooms persist across related outcomes, but make each active work item independently understandable. A person may contribute to one bounded request without gaining the entire project's history.

Local-first research informs responsive drafting and user control, not offline authority for membership or external actions. Do not rewrite the existing collaboration model merely to make the composer faster. [Kleppmann et al., Onward! 2019](https://www.inkandswitch.com/essay/local-first/).

**Validation:** A private excerpt must remain absent from another member's search, summary, notifications and agent context until explicitly shared.

## 3. How does a request become an agreement to do work?

**Product:** Agents should notice requests and start helping immediately.

**Reviewer:** Not every idea is an instruction, and volunteering is not assignment.

**Decision:** Preserve three distinct states: request, offer and accepted assignment. A compact work card states the intended result, what makes it acceptable and who owns delivery. Deadline, budget and special constraints appear only when relevant. A worker can offer help; an authorized requester selects the offer; accepting an assignment binds that worker to its exact scope. Changes require renewed agreement when material.

Agents may draft a proposed work card from conversation. They must not silently convert discussion into a spending commitment or exclusive claim. Humans may simply choose “I'll do it” when no offer negotiation is needed.

This adapts intake discipline and the A2A distinction between messages and tracked tasks without requiring A2A for every interaction. [Linear](https://linear.app/docs/triage), [A2A task lifecycle](https://a2a-protocol.org/latest/topics/life-of-a-task/).

**Validation:** Two simultaneous selections cannot create two authoritative owners for the same exclusive assignment. A declined offer leaves no active execution authority.

## 4. How can anyone contribute with existing tools?

**Product:** Provide API and MCP access so agents can participate directly.

**Reviewer:** Some products cannot install tools. Some people only want to paste a prompt.

**Decision:** Support three equivalent entry routes to the same work record: browser contribution, authenticated agent connection and a portable work packet with manual return. The packet contains the task reference, scope/version, selected context, expected result and return instructions—never embedded credentials. A returned contribution must attach to a real work item and preserve attribution, while clearly distinguishing verified connected identity from a manually entered claim about its author.

All routes support useful participation; they do not have identical trust guarantees. Stable errors, bounded context, durable receipts and resume instructions matter more than the length of our integration catalog. A2A explicitly leaves artifact-version linkage to clients, so Project Room must own that mapping. [A2A](https://a2a-protocol.org/latest/topics/life-of-a-task/).

**Validation:** Complete the same reference task through all three routes. A packet copied into an unsupported AI must still have a usable return path.

## 5. How do collaborators share context without sharing everything?

**Product:** Give agents the context they need to perform well.

**Reviewer:** Who determines what they need, and does a summary accidentally reveal excluded sources?

**Decision:** Give each assignment a bounded context packet: objective, selected sources, relevant decisions, current artifact revision and granted tools. Provide authorized retrieval for additional context, not a full-history dump. Permission enforcement happens in the service for reads, searches and derived outputs; a prompt saying “keep this private” is not access control.

Sharing source-derived summaries requires attention to the underlying audience restrictions. Adding a member does not automatically authorize access to the original mailbox or repository. Removing access prevents future authorized retrieval but cannot erase copies already exported to external tools.

Zanzibar provides a useful precedent for evaluating content access consistently with permission changes; its large-scale architecture is not a dependency proposal for us. [Pang et al., USENIX ATC 2019](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/).

**Validation:** Test membership changes during retrieval and generation, including cached summaries and stale contribution packets. Refuse unauthorized sharing rather than silently broadening the audience.

## 6. How do contributors avoid collisions?

**Product:** Parallel agents could make work much faster.

**Reviewer:** They could also overwrite one another, duplicate work or repeat the same external action.

**Decision:** One accountable owner for each bounded mutable work item; many explicit reviewers or alternative proposals are allowed. Split independent outputs into separate items. Use revision checks, expiring execution claims and server-enforced current ownership. Isolate file edits in separate branches/workspaces where applicable. A lease alone does not isolate edits or prove an external worker stopped.

An expired worker may submit a late result as a proposal, but it cannot silently replace current accepted work. External actions require separate admission and receipts; task ownership is not blanket authority to send or spend. Start with explicit boundaries rather than attempting to infer all semantic conflicts automatically.

The previously pinned QM run-store review supplies a concrete implementation precedent for queued work and leases, not proof of our own correctness. [QM pinned source](https://github.com/yc-software/qm/blob/60ba79195dc84aa85a23f238749656e11c88696c/src/runs/postgres-run-store.ts).

**Validation:** Race two workers, expire one, then deliver its result late. No silent overwrite, duplicate admitted effect or lost accepted artifact is acceptable.

## 7. What may agents do independently?

**Product:** Too many permission dialogs undermine automation.

**Reviewer:** Too much implied authority undermines trust.

**Decision:** Authorize bounded activities, not a general “trusted agent” status. Within an active assignment, agents can read approved context, analyze, draft and submit reversible proposals without repeated confirmation. In the first release, outward messages, destructive changes, new spending and wider sharing require an authorized person's approval of the specific proposed action.

Approval identifies the payload, audience, scope and revision; changing them invalidates it. Future recurring automation can use explicit narrow standing grants with limits and revocation. Connecting an agent, sharing context and granting action authority remain separate operations.

Human-AI interaction guidelines support predictable invocation, dismissal and correction. LangGraph's restart semantics illustrate why durable approval and side-effect handling cannot live only in an agent's transient conversation. [Amershi et al., CHI 2019](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf), [LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts).

**Validation:** Restart after approval and after an external attempt. Recheck authority and recover the original receipt; do not treat a retry as fresh permission.

## 8. What counts as a useful, accepted result?

**Product:** The agent reports completion and attaches its output.

**Reviewer:** That proves only that it stopped working.

**Decision:** Track submitted, checked and accepted separately. Acceptance names a particular artifact revision and an authorized reviewer. Relevant evidence might be sources for a brief, test results for code or a preview for a design. Automatic checks inform review; they do not universally establish usefulness. Self-acceptance by the worker is not the initial default.

Keep the latest accepted result easy to find, with alternatives and history available behind it. Material revision requires renewed acceptance. Copying, sending or publishing is a separate delivery event; provider confirmation must not be inferred from artifact acceptance. “Useful in practice” is a later explicit signal, not a synonym for clicking Accept.

GitHub's configurable stale-review dismissal is a clear precedent for binding approval to reviewed content. [Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

**Validation:** Modify an accepted draft and attempt delivery under its old approval. The old approval must not authorize the changed content.

## 9. How do we keep the next action obvious and the interface quiet?

**Product:** Hide complexity until someone needs it.

**Reviewer:** Hidden controls and unlabeled icons can make the product harder, not simpler.

**Decision:** Use two familiar destinations: Inbox and Rooms. Initially Inbox means personal attention and invitations, not an already-connected universal mailbox. A room centers conversation, its current result and a compact contextual work card. Surface one primary next action for the current state. Keep owner, audience, status and meaningful consequences visible; put technical details, history and uncommon controls one level deeper.

Use short verbs such as Review, Share and Retry where an icon is ambiguous. Desktop Enter sends ordinary chat; Shift+Enter inserts a newline, with composition/accessibility handling and a mobile send control. Enter must not accidentally approve a payment or external action. Optional features remain discoverable from stable locations rather than unlocking unpredictably with account age.

Progressive disclosure supports prioritization, not hiding essentials. Topic-following suggests a way to reduce notification noise without removing access. [Nielsen Norman Group](https://www.nngroup.com/articles/progressive-disclosure/), [Zulip](https://zulip.com/help/follow-a-topic).

**Validation:** Simulated first-time users should find the result, owner and next action without explanatory paragraphs. Label these as simulations, not real user research.

## 10. What happens when work changes, fails or stops?

**Product:** Retry automatically so users rarely see failures.

**Reviewer:** A timeout might mean a message was sent even though its acknowledgment was lost.

**Decision:** Model uncertainty honestly: not attempted, pending, succeeded, failed and unknown are distinct. Preserve a stable operation identity and receipt across retries. Reconcile with the destination when supported; otherwise hold an uncertain consequential action for review instead of blindly repeating it. Never promise universal exactly-once execution across unrelated providers.

Autosave permitted drafts, preserve accepted artifacts and let a new worker resume from approved state. Cancellation prevents further authorized work; it does not unsend messages or guarantee termination of a disconnected external agent. Clearly distinguish cancellation requested from confirmed stopped. Use the existing event/history authority rather than creating a second state machine that disagrees with it.

Checkpoint replay can repeat pre-interrupt effects, making idempotency and recovery explicit design requirements. [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/interrupts).

**Validation:** Inject lost acknowledgments, duplicate callbacks, offline clients, expired grants and restarts at action boundaries. Inspect visible recovery states as well as server invariants.

## 11. Why will people return, invite others and pay?

**Product:** More features, rewards and agent activity could drive growth.

**Reviewer:** Activity is not value, and forced upgrades damage the free experience.

**Decision:** Make returning useful: the accepted result is easy to recover, the next decision is clear, and a second request needs less setup. Invite others for a specific contribution or review, not to satisfy a viral checklist. Offer optional sanitized templates with no private content or live grants. Agents benefit from clear work, discoverable permitted help requests, usable context, reliable receipts and attributable accepted contributions—not artificial engagement incentives.

Keep manual collaboration and bring-your-own-agent participation meaningful on the free tier, with disclosed resource limits. Charge for hosted execution and higher operational capacity, using allowances and explicit caps rather than surprise overages. No price is justified yet by measured costs. Basic safety, revocation and access to one's results must not be premium-only.

Linear and Notion provide precedents for a useful core alongside paid capacity or AI features; their pricing does not establish our economics or willingness to pay. [Linear pricing](https://linear.app/pricing), [Notion pricing](https://www.notion.com/pricing).

**Validation:** Observe repeat useful work and variable cost before deciding plan limits. Defer paid-bounty launch until separate payment, dispute and abuse requirements are satisfied; this document makes no payment-integration decision.

## 12. What do we build now, and what would change the direction?

**Product:** Build the broad platform while the opportunity is large.

**Reviewer:** Breadth can hide a weak core collaboration loop.

**Decision:** Finish the existing collaboration foundation, then prove one complete workflow before adding channels. Earlier recorded checkpoints contain durable help offers; negotiated agent context/tools, compact human offer controls and compatible recovery still require completion and verification. These are prior recorded states, not tests rerun for this research document.

Human-plus-AI combinations do not automatically beat the stronger constituent. A 2024 meta-analysis found average augmentation over humans alone but not average synergy against the stronger human/AI baseline in its studied tasks. That evidence predates current agents and does not predict our product's results. It does require us to compare alternatives rather than equate more participants with better outcomes. [Vaccaro et al., Nature Human Behaviour](https://www.nature.com/articles/s41562-024-02024-1).

**Validation:** If the room adds administration without better accepted results, reduce the workflow. If people repeatedly perform useful work but struggle with transfer, prioritize the relevant connector. If they cannot find authorized help, improve matching before adding agent runtimes. If hosted execution is too expensive, improve efficiency and favor user-supplied execution rather than silently degrading the free core.

## Implementation order and gates

1. **Finish current work ownership.** Inspect the actual checkout, preserve existing changes, complete negotiated context and compact offer/select/release controls. Verify current-authority recovery and older-client compatibility. No new framework or parallel source of truth.
2. **Ship one local vertical slice.** Request, explicit assignment, selected context, versioned contribution, review, accepted result, copy/download. Human-only completion must work. Reuse existing cards, dialogs and event contracts where possible.
3. **Make the same slice agent-accessible.** Connected API/MCP operations and a portable packet/manual-return route use the same authority and work records. Test authenticated and manual attribution separately. Feature count is not the acceptance criterion.
4. **Qualify failure and usability.** Race ownership; invalidate stale approval; revoke access; replay requests; lose receipts; restart clients. Run browser simulations on desktop and mobile, keyboard/accessibility checks and actual scoped agent participation. Keep screenshots, operation receipts and test logs, with credentials and private material excluded.
5. **Instrument outcomes and run a small pilot.** Use the definitions below. Real participants are required for behavioral validation later; simulated personas cannot establish retention or willingness to pay. This step is a future research gate, not a request for John to answer more product questions now.
6. **Add one connector based on repeated transfer friction.** Keep inbox access private and sharing explicit. Provider selection depends on actual demand and supported interfaces. Universal messaging, broader automation and bounties follow the successful loop rather than preceding it.

Functional release gate: all specified critical permission, ownership, approval and recovery checks pass; any known unauthorized disclosure, stale approval admission or duplicate consequential effect blocks release. Passing a bounded suite is evidence, not proof of universal correctness. Publishing remains a separate authorized action.

## Prospective measurement plan

This section applies the KPI-design skill. There is no verified usage baseline in this research. These definitions are proposed instrumentation, not existing metrics or performance claims. HEART provides a precedent for mapping user goals to observable signals; our particular formulas are product hypotheses. [Rodden et al., CHI 2010](https://research.google/pubs/measuring-the-user-experience-on-a-large-scale-user-centered-metrics-for-web-applications/).

### Two primary measures

**First useful outcome within seven days.** Denominator: unique non-test requesters who initiate their first real request, with a full seven-day observation window. Numerator: those with an accepted artifact and an explicit useful/used confirmation within that window. Record request creation, acceptance revision, acceptance actor and usefulness confirmation as separate events. Report counts and the missing-confirmation share alongside the rate. Nonresponse is not proof of uselessness; this is a conservative observable proxy. Weekly review by the product owner; investigate abandonment and confusing review states before adding features.

**Repeat useful work within twenty-eight days.** Denominator: first-outcome requesters with a full twenty-eight days after their first confirmed useful result. Numerator: those initiating a distinct second request after that first result and obtaining another accepted, useful-confirmed artifact within twenty-eight days. Exclude duplicate/reopened revisions of the same request. Weekly matured-cohort review by the product owner. Segment by workflow cadence: a naturally infrequent task may be valuable without monthly repetition. This is not generic daily engagement.

### One diagnostic driver

**Time to first accepted useful result.** Elapsed time from initial request to useful confirmation; report the median for successful cases together with the full cohort's completion rate and incomplete-case count. Event timestamps provide the source. Review weekly with engineering to distinguish waiting, unclear scope, execution time and review friction. Do not present the successful-case median alone as representative of all users.

### Two guardrails

**Confirmed unintended disclosure or unauthorized action.** Count confirmed incidents by severity and route from audit records, support reports and release tests; include a count of investigated reports. Engineering triages immediately, and the product owner reviews weekly. Zero observed incidents is not proof of zero incidents. Any confirmed serious incident pauses the affected path while contained; do not bury it in an average success rate.

**Variable cost per accepted useful outcome.** For a matured request cohort, divide all attributable provider, execution and variable storage costs—including failed and unaccepted attempts—by its accepted useful outcomes. Record currency and provider billing basis; reconcile estimates against invoices. Zero outcomes makes the ratio undefined, not zero. Report unallocated costs separately. Weekly product/engineering review informs allowances and architecture. This excludes fixed labor and is not a gross-margin calculation. No numerical target is set before a baseline exists.

### Explicitly rejected success proxies

Messages sent, agents connected, tokens consumed, rooms created and invitations sent can diagnose use but are not primary success measures. Their growth can reflect noise, waste or spam. Acceptance clicks alone are insufficient; usefulness confirmation adds evidence but remains self-report. Report aggregate counts carefully, avoid placing message bodies or credentials into analytics, and retain clear test-traffic exclusions.

## What this settles

The near-term product is an outcome-centered collaboration room with a lightweight interface and explicit authority underneath. The immediate priority is the shared work-and-review loop, usable by humans, connected agents and externally assisted contributors. The expansion path remains messaging, managed automation and rewarded work—but each must strengthen that loop instead of becoming a separate product inside the navigation.

This decision record refines the earlier Collaboration and Messaging Plan and RESEARCH-EXPANSION.md. It does not replace their provider constraints, source-review caveats or launch gates. No production capability should be inferred from a proposed design.
