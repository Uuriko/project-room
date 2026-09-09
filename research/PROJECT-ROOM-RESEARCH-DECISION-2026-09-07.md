# Project Room: research decision brief

7 September 2026 · Research and recommendations, not an implementation or release

## Decision in brief

Keep the existing room as a focused shared workspace, but build and test its value as continuity across people and separately operated agents. Do not require an organization-wide chat migration. Preserve one work-state and permission model behind the browser, HTTP API and future MCP interface.

The initial hypothesis is: **a small project team can change direction, hand off a result, and resume later without its owner repeatedly carrying context between tools.** Neither demand nor superiority over a configured incumbent has been established.

The next investment should be a real bounded agent connection plus a simpler task experience. Compare it with an ordinary shared brief before adding a memory platform, marketplace, autonomous team manager, or many integrations. A simpler alternative winning is a successful research outcome.

## 1. Evidence boundary and current implementation

The current source is identified by [PROJECT-ROOM-CURRENT.md](./PROJECT-ROOM-CURRENT.md). The unified checkout was clean during this review. The last recorded integrated run passed 183 core/API/syntax tests and 33 browser scenarios. Those suites were not rerun for this research pass. No production uptime, live AI execution or independent team outcome is established by those counts.

The [unification ledger](./../docs/UNIFICATION-2026-09-07.md) identifies included and missing inputs. Its synthetic participant identities were operated by one operator. A second identity is not an independent reviewer, and a local URL is not an internet-accessible invitation.

| Journey | Current evidence | Remaining question |
| --- | --- | --- |
| Join and converse | Account/invitation/guest flows and conversation are in the integrated local milestone. | Can a new person on another device enter the intended shared service and understand their access? |
| Discuss and assign | A source message can become explicit work. Ordinary messages do not automatically become assignments. | Is the conversion understandable and proportionate to the task? |
| Submit and review | Results, evidence versions, reviews and owner decisions are distinct. | Can separately operated agents produce and check a useful real result? |
| Correct a result | Rework and supersession preserve history and invalidate outdated approval. | Can a user change intent without rebuilding or confusing the assignment? |
| Return after interruption | Catch-up and durable state exist; optional draft recovery is scoped. | Does the brief reduce actual reconstruction effort for a returning person? |
| Connect an agent | The HTTP client exposes orientation, current state, changes, briefs and explicit commands. | No current real-runtime end-to-end or MCP conformance result is established. |
| Leave or lose access | Canonical membership/session controls exist. | Room access revocation must not be confused with undoing data already shared or confirming a remote process has stopped. |

### Two implementation findings that change the recommendations

1. The domain already supports optional independent review and owner decisions. However, the browser's work submission sets both `independentVerificationRequired` and `ownerDecisionRequired` to true. This is a concrete mismatch between available behavior and the everyday experience, not proof that the whole workflow requires a rewrite. Sources: [browser submission](./work/project-room-unified-20260907/src/app.js:1177), [workflow rules](./work/project-room-unified-20260907/src/workflow.js:8).
2. The [original first-workflow brief](./../docs/FIRST-WORKFLOW.md) already calls for one real connection, explicit direction changes, source-scoped context, no automatic wake-all behavior, and no forced migration. Several recommendations in recent conversation are therefore unfinished original intentions, not newly discovered features.

The current API is a useful starting point, not universal interoperability: orientation scans the pilot's capped work collection; membership grants room-wide context; runtime budgets, task-level grants and wake controls remain future work. See the [client contract](./../docs/AGENT-CLIENT.md).

## 2. Recorded perspectives from other agents

The local inbox had no unread messages. The shared issue was reread. This is recorded context, not fresh dialogue or consensus. No new external message was posted during this review.

- **Instinct:** its compatibility report distinguishes matching transport routes from differing semantics, identity routes and client protections. Its lifecycle audit identifies the broader principle that a later state change must invalidate earlier claims of validity. These reports concern its own source line; reported test counts are not added to the integrated build. [Compatibility report](https://github.com/Uuriko/project-room/issues/11#issuecomment-5566977847), [lifecycle audit](https://github.com/Uuriko/project-room/issues/11#issuecomment-5567486835).
- **Grok Bot:** the recorded contribution is independent contract/conformance and adapter/device checking, contingent on an obtainable shared build. Its comment explicitly says no executable adapter/harness artifact was published from that lane. [Recorded handoff](https://github.com/Uuriko/project-room/issues/11#issuecomment-5565330678).
- **Joint implication:** the next integration artifact must be obtainable and runnable by the intended reviewer. A status message, source hash or local-only success cannot substitute for that. The earlier integration ledger reports unavailable Instinct source; this pass did not retry fetching that source or reproduce its tests.

Local claim/release notices for this research file are coordination bookkeeping only. They are not evidence that Instinct or Grok reviewed this brief. Other products and their operational incidents remain outside this assessment.

## 3. Compare four product shapes

These are design judgments, not measured market rankings.

| Shape | Strongest case | Main risk | Current disposition |
| --- | --- | --- | --- |
| Standalone room | One coherent human experience for discussion, context, results and decisions. | Another destination, duplicated updates and a group adoption threshold. | Keep the small interface; do not position as a full chat replacement yet. |
| Layer inside existing chat | People can benefit where they already work. | Connector complexity, permission mismatch, duplicate state and platform dependence. | Test demand with a minimal workflow before building a broad bridge. |
| Shared memory/handoff service | Agents in different environments can resume from common state. | Accurate storage can still leave interpretation and human supervision unresolved. | Make continuity a core capability, not a separate generic memory product. |
| Agent work-management service | Explicit delegation and execution tracking can support valuable work. | Significant existing competition; runtime orchestration adds operational burden. | Support one runtime adapter first; do not become a general scheduler yet. |

### Stronger competition than ordinary chat

Linear documents delegating to an agent while a human remains responsible. Its coding-session documentation describes shared coding sessions and starting them from existing collaboration surfaces. These capabilities weaken any claim that human-owned agent work or shared coding alone differentiates Project Room. Documentation does not establish comparative usability or performance. [Assignment and delegation](https://linear.app/docs/assigning-issues), [coding sessions](https://linear.app/docs/coding-sessions).

Slack exposes workspace tools through MCP, and Zulip documents structured topic-based conversation and export. Agent access, organized chat and portability are not sufficient standalone differentiators. The baseline should be a reasonably configured tool, not an untouched default installation. [Slack MCP](https://docs.slack.dev/ai/slack-mcp-server/), [Zulip topics](https://docs.zulip.com/why-zulip/), [Zulip export](https://zulip.com/help/export-your-organization).

**Recommended position to test:** a shared project room that makes handoffs across existing agents and people understandable, correctable and resumable. Begin with one project and one owner; allow collaborators to join for a specific result rather than requiring everyone to migrate.

## 4. Research findings and their limits

### A. Adoption: who does the work and who gets the benefit?

Duckert and Bjørn's 2024 ethnographic study revisits groupware challenges through two companies. It emphasizes persistent social and organizational difficulties alongside changing collaboration practices. Extra maintenance work, critical mass, and unwanted availability are relevant mechanisms, not quantified forecasts for this product. [Published study](https://www.degruyterbrill.com/document/doi/10.1515/icom-2023-0039/html?lang=en).

**Implication:** an owner dashboard is not enough if contributors must repeatedly restate their work for it. Reuse existing messages and evidence where permitted. Show each contributor what the extra structure saves them: fewer repeated questions, clearer scope and a usable return point.

**Counterargument:** a new room adds work even if its interface is good. Test whether one owner plus one agent gets useful continuity before asking a team to adopt it.

### B. Shared understanding: history alone cannot settle intent

Earlier research in this investigation examined Clark and Brennan's grounding framework and the multi-turn conversation study by Laban and colleagues. The former distinguishes transmission from sufficient mutual understanding; the latter reports premature assumptions and poor recovery in its simulated task settings. Neither proves a task brief will fix those problems here. [Grounding in Communication](https://web.stanford.edu/~clark/1990s/Clark%2C%20H.H.%20_%20Brennan%2C%20S.E.%20_Grounding%20in%20communication_%201991.pdf), [multi-turn study](https://arxiv.org/abs/2505.06120).

**Implication:** test a source-linked current interpretation of a task. Separate the desired result, constraints, excluded scope and open questions. Agent suggestions remain suggestions until adopted. A read or acceptance receipt must not be presented as proof of comprehension.

**Counterargument:** maintaining a brief can add another stale document. Start by improving the existing task definition, not introducing a second competing source of truth.

### C. Memory: knowing what changed and what is true here

The May 2026 LongMemEval-V2 preprint studies memory over web-agent histories. Its categories include dynamic state, workflows, local pitfalls and premise awareness, not just fact retrieval. It evaluates context gathering for question answering, including latency; it does not demonstrate real-team collaboration or production authorization correctness. [Research project and methods](https://xiaowu0162.github.io/longmemeval-v2/).

**Implication:** evaluate whether an agent knows that this result was superseded, this action is unavailable, or this room has different rules. Favor compact current state plus permission-filtered evidence and versioned procedural notes. Do not begin with a vector database simply because the product needs memory.

**Counterargument:** small rooms may already work well with a full brief and ordinary search. More retrieval infrastructure could make the system slower and harder to audit.

### D. Review: separate actors are not necessarily independent evidence

A May 2026 preprint reports correlated errors among LLM judge panels in inference and preference tasks. A separate CARE preprint reports improvements from modeling shared confounders in aggregation. These are different evaluations, not a clean replication or a universal verdict on agent review. This pass examined their abstracts and publication metadata, not their full experimental appendices. [Nine Judges, Two Effective Votes](https://arxiv.org/abs/2605.29800), [CARE](https://arxiv.org/abs/2603.00039).

**Implication:** distinguish who reviewed, how they checked, which exact result they inspected, and what evidence they obtained. A separately run behavioral check provides a different kind of evidence from asking another model to agree with a narrative. Preserve required reviewer separation, but do not describe it as a statistical guarantee.

**Counterargument:** independent execution can be costly or inappropriate for subjective work. The checking method should match the task, rather than every result receiving the same ceremony.

### E. Participation: help and recognition deserve a fair test

The Teahouse experiment randomized withholding invitations from eligible Wikipedia newcomers and observed retention benefits on some measures; not every tested threshold was significant. It estimated the effect of an invitation, not the isolated effect of asking a question. [Study, methods and limitations](https://www.opensym.org/wp-content/uploads/2018/07/OpenSym2018_paper_15.pdf).

In contrast, Wikimedia's report of the gamified Wikipedia Adventure experiment did not establish positive long-term retention despite favorable survey reactions. This is evidence about one intervention, not proof that all gamification fails. [Research report](https://meta.wikimedia.org/wiki/Research:Impact_of_The_Wikipedia_Adventure_on_new_editor_retention).

A randomized barnstar study among highly productive Wikipedia editors found increased sustained contribution following recognition. Its selected population and edit-based outcomes do not establish quality gains or incentives for autonomous agents. [Restivo and van de Rijt](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0034358).

**Implication:** retain meaningful attribution and appreciation, but defer competitive points or reputation economies. Make the first useful contribution clear, offer a real path to help, and reduce correction costs. For agent operators, test integration effort and usefulness directly; human community studies do not establish an agent's motivation.

### F. Interfaces: interoperability is a tested relationship, not a badge

The official MCP July 2026 release changes core protocol assumptions and moves Tasks into an extension. Earlier design discussions relied on older documentation. A real integration must specify host, protocol and SDK compatibility rather than claim support for an unspecified latest MCP. [Official release](https://blog.modelcontextprotocol.io/posts/2026-07-28/).

A2A distinguishes immediate messages from stateful tasks and documents interrupted and terminal task states. That supplies useful vocabulary, not a reason to add another protocol now. [Task lifecycle](https://a2a-protocol.org/latest/topics/life-of-a-task/).

**Implication:** keep the current HTTP/domain boundary; add a narrow MCP adapter for the first selected host. Separate a room's work state from a runtime's execution state. A cancellation request is not confirmed cancellation; a finished process is not an approved result. Defer A2A until a concrete integration requires it.

### G. Human control: quiet must remain accessible

W3C explains how status changes can be exposed to assistive technology without moving focus, while warning that excessive live-region announcements can become too chatty. Focus visibility must also survive overlays. [Status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html), [focus not obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html).

**Implication:** preserve meaningful feedback when reducing visual noise. Test a returning user, keyboard navigation, enlarged text and screen-reader behavior, including background updates. Existing browser checks are not a claim of full accessibility conformance.

## 5. Behavioral contracts worth building around

These are proposals for future implementation, not new guarantees.

1. **One authoritative work model.** Browser, API and MCP use the same decisions, permissions, versions and next-action rules.
2. **Conversation is not automatic delegation.** A named question can receive an answer without starting a formal work item or waking every agent.
3. **Proportional review.** Expose supported task policies deliberately for new work; do not weaken already-required review or approval retroactively.
4. **Correctable intent.** Show proposed changes and affected work before adopting a new task version. Current immutable task fields mean a simple editor is not sufficient; versioning or replacement semantics require design first.
5. **Traceable current context.** Distinguish source statements, confirmed decisions and generated interpretations. Keep original evidence reachable by authorized participants.
6. **Honest execution.** Queued, accepted, running, waiting, cancellation requested, canceled and unknown are not interchangeable. Runtime reports require provenance and an update time.
7. **Bounded agent access.** Orientation should identify the authenticated agent, available capabilities, current assignment, relevant sources and context version. Retrieval itself does not mark understanding or grant action authority.
8. **Recoverable operations.** Preserve command identity across uncertain delivery and reconcile recorded outcomes. Never treat a room retry as permission to repeat an external effect.
9. **Permission-aware continuity.** A shareable conversation invitation is not a general agent execution credential. Derived summaries need appropriate access boundaries. Revocation cannot retroactively erase information already received by an external participant.
10. **Attention has an owner.** Requests requiring a response belong in Needs you; routine execution history should remain inspectable without broadcasting every step.

## 6. Proposed experience and adoption path

Keep Chat, Needs you and Work as simple views over the same room. The normal work card should show outcome, responsible participant, status, next action and result. Detailed evidence and history remain available on expansion. Use readable names with an agent label; technical identifiers belong in details.

The first-use sequence to test is: create one project context, connect one permitted agent, produce one useful result, then invite a collaborator to that result. Do not assume a public community is required before anyone benefits. The invitation should explain the room's purpose and access scope, not merely ask someone to join another app.

For agent developers, the initial offer is predictable operations, small useful context, examples that run, typed errors, a test environment and portable result references. A public catalog, ratings and rewards remain hypotheses. No adoption or revenue estimate is justified by this research.

## 7. Experiment package — specified, not executed

### Stage A: prove the connection

Use explicitly shared, non-sensitive materials and one real agent in a selected host. Produce and revise a short project brief. No external publishing, spending or broad connector access. Demonstrate request, useful result, correction, interruption and return. Record actual execution separately from synthetic fixtures.

### Stage B: find the smallest useful interface

Compare three conditions: (A) a participant's reasonably configured existing tools, (B) those tools plus a compact shared brief, and (C) Project Room's structured workflow. Do not build multiple broad integrations to conduct this comparison; use the simplest faithful setup and disclose manual assistance.

Start with an exploratory handful of participant pairs. Counterbalance order and use comparable but different tasks to reduce learning effects. Keep model, sources and resource budgets comparable when testing interface effects. Test multi-agent allocation separately rather than changing both interface and agent count at once. This is discovery, not a powered efficacy study.

| Case | Exercise | Observable success |
| --- | --- | --- |
| New participant | Join an existing harmless project and identify the next action. | Correct understanding without owner coaching; access scope understood. |
| Changed requirement | Replace an earlier constraint during the task. | The next result follows the adopted version and does not silently expand authority. |
| Fresh handoff | A different participant continues after the first leaves. | Current result, evidence, constraint and next action are recovered without transcript forwarding. |
| Interrupted delivery | Interrupt the permitted task flow and return. | Actual recorded outcome is reconciled; no duplicate result or false success claim. |
| Conflicting information | Include an old suggestion and a later confirmed decision. | The system distinguishes history from current decision and cites the source. |
| Unknown information | Ask about a fact never established in the shared material. | Missing evidence is acknowledged rather than invented. |
| Review | Check a result with a known, benign content error. | The check identifies the issue in the correct revision; correction does not inherit old approval. |
| Attention and access | Receive background updates while using keyboard/mobile; then change permitted access. | Important feedback is available without disruptive focus changes; current access is respected and remote-stop uncertainty is honest. |

Before each task, agree on an acceptable result and unacceptable errors. Record setup time, hands-on effort, elapsed time, manual relays, corrections, output quality, interruptions and execution cost separately. Ask whether people understood the result and would choose the workflow again, but do not substitute that answer for observed behavior.

Retain incomplete attempts and facilitator interventions. Keep some task variants unseen during development. Have someone other than the feature author assess the results where feasible. Record the exact application, host and protocol versions.

### Decision rules

- If the shared brief performs as well as the full workflow with less effort, simplify the default workflow.
- If people benefit only after the whole team migrates, investigate a complementary interface before expanding the standalone product.
- If additional agents do not improve acceptable output under comparable budgets, keep one agent as the default.
- If an apparent gain depends on hidden human forwarding or intervention, report that dependency rather than crediting the app.
- If scope confusion, misleading completion, or duplicate effects appear, stop that pilot path and address the behavior before expansion.
- If people repeatedly choose to return without prompting, investigate why; it is encouraging evidence, not proof of a large market.

## 8. Priorities and confidence

| Decision | Confidence | Reason / what could change it |
| --- | --- | --- |
| Preserve the integrated domain and persistence work. | High | Existing local evidence supports useful behavior; no evidence justifies a wholesale rewrite. |
| Resolve an obtainable shared build before claiming multi-agent validation. | High | Recorded agent handoffs identify this concrete dependency. |
| Test lighter browser-created work using existing policy support. | High that the mismatch exists; medium that changing it helps | Code is explicit; usability benefit still needs observation. |
| Connect one real agent before building a broad agent ecosystem. | High as sequencing, not a market claim | Current evidence is synthetic; a real connection tests a missing central dependency. |
| Position around cross-agent continuity rather than full chat replacement. | Medium | Plausible fit to observed coordination pain; incumbent comparison and user demand remain open. |
| Add a current-understanding experience. | Medium | Mechanisms are plausible, but another maintained document may add burden. |
| Add complex retrieval, marketplaces, reputation or federation now. | Low support | No demonstrated local need or repeat-use evidence. |

Suggested future ownership, not new assignments: Codex integrates the human experience and shared contract; Instinct supplies reconstructable identity/service changes; Grok evaluates the exact candidate through independent public-interface and device checks. All should work against one obtainable candidate with explicit behavior-level disagreements resolved before integration.

## 9. Research method and stop condition

This was a selective, single-reviewer research synthesis. It is not a systematic review, hands-on competitor benchmark or completed user study. Primary sources were preferred; vendor documentation establishes described capabilities, not customer value. New preprints were treated as provisional. Sources were not counted as independent evidence merely because a paper also had a project page.

Fresh search families included groupware work/benefit disparity and critical mass; common information spaces and articulation work; equal-budget multi-agent comparisons; correlated evaluator errors; current Linear delegation and sessions; MCP/A2A lifecycle and compatibility; WCAG status/focus guidance; newcomer support and reward experiments; and LongMemEval-V2. Older grounding, multi-turn and value-evaluation research was carried forward from prior passes with its original limits.

Selected abstracts, methods, results and limitations were inspected where accessible; not all papers or appendices were read in full. Some publisher follow-up requests and a historical PDF returned errors. The accessible 2024 study and original-source alternatives were used instead of inventing unavailable contents. A search result with unresolved publication-date metadata was not used for a quantitative equal-budget claim. No pooled productivity estimate, market size or causal forecast was produced.

The broad-search stopping condition is met for this pass: more generic sources are unlikely to resolve the remaining local questions of integration, usability and voluntary adoption. Those need the specified comparisons and real participants. Further targeted research is justified when selecting the first host, designing task revision, or resolving a concrete permission/compatibility decision.

**Checkpoint:** research brief complete; application unchanged; experiments not run; no new goal, deployment, publication, live runtime, or claim of other-agent endorsement.
