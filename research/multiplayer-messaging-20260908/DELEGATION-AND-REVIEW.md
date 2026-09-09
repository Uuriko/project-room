# Project Room: delegation that earns its complexity

September 8, 2026. Follow-up to TWELVE-DECISIONS.md. This round tests the assumptions behind delegation, agent discovery, review and lightweight collaboration. Findings below distinguish empirical research, conceptual proposals, documented product behavior and our own design hypotheses. No runtime changes or experiments were performed.

## What changes in the plan

Keep the request-to-reviewed-result direction, but tighten it in six ways:

1. Default to one worker; add collaborators for a specific missing capability, independent output or review.
2. Establish how the result will be checked before accepting the work.
3. Separate accountable owner, current editor and approver without creating three mandatory setup forms.
4. Treat agent profiles as claims, connection tests as compatibility evidence and accepted work as contextual performance evidence.
5. Make routine progress quiet while preserving durable decisions and effects.
6. Make review inspectable, not merely easy to approve.

These are changes to proposed implementation defaults, not implemented capabilities or measured benefits.

## 1. Delegation has a cost floor

**Evidence.** Tomašev, Franklin and Osindero's February 2026 preprint, Intelligent AI Delegation, frames delegation around scope, responsibility, permissions, verification and adaptation. It explicitly notes that negotiation and oversight can cost more than a small task is worth. This is a conceptual framework, not an experimentally validated product blueprint. Selected framework and discussion sections were reviewed. [Paper, v1](https://arxiv.org/html/2602.11865v1).

**Our decision.** A request does not automatically produce a manager and several workers. Start with direct work by one capable participant. Offer more help when there is an independent output, an unmet skill or a genuine checking need. Before dispatch, establish the expected output and a feasible check. For subjective work, use a small agreed rubric and human acceptance; do not pretend recursive decomposition makes every creative judgment objectively provable.

**What not to borrow.** The paper's broader market and cryptographic mechanisms are not prerequisites for a useful room. A signature proves an attestation's origin, not that a draft is good. Passing tests establishes only what those tests cover. No payment or legal arrangement is prescribed here.

**Prototype test.** Compare a one-worker flow with a worker-plus-reviewer flow on the same source-grounded response task. Include setup, review and correction effort; do not compare only generation latency.

## 2. Coordination quality is not product quality

**Evidence.** Anthropic's August 2026 multiagent research report describes game-building experiments in which coordination patterns differed across models, yet the resulting products remained poor. Prompted organizational roles were not sufficient to produce good experiences. This is a vendor-reported experiment, not independent validation of our product or a universal model ranking. Only the relevant coordination/game-building sections were reviewed. [Patterns and problems in emerging multiagent systems](https://www.anthropic.com/research/multiagent-systems).

**Our decision.** A room is successful when its output works for the intended recipient. More merged changes, completed subtasks or agent messages cannot substitute for that. Name one integration owner for dependent work and maintain a working end-to-end example throughout development. Parallel research is not evidence that parallel edits to a shared interface will integrate well.

**Prototype test.** Give two contributors different parts of a small interface change. Require an integrated, usable result and a reviewer walkthrough—not two independently passing fragments. Include deliberately mismatched assumptions about the interface contract. This remains a proposed bounded functional test, not a broad vulnerability-discovery exercise.

## 3. Turn failure research into a practical test inventory

**Evidence.** MAST v3 describes 1,642 execution traces across seven frameworks and fourteen failure modes grouped around system design, inter-agent alignment and verification. The taxonomy began with expert analysis of 150 traces; the larger collection uses model-assisted annotation. Those are different evidence sets and should not be conflated. The paper does not claim exhaustive coverage. Abstract, methods and the failure taxonomy overview were reviewed. [Cemri et al., v3](https://arxiv.org/html/2503.13657v3).

**Our decision.** Tag failures by what broke rather than labeling every unsuccessful run “agent error.” Initial internal categories: unclear scope, lost context, ignored handoff, repeated work, premature completion and insufficient checking. These are debugging tags, not another user-facing taxonomy or reputation score.

**Prototype test.** Seed one recoverable problem at a time: omit a required source; change the target revision; deliver feedback after a worker restart; submit a result missing a requested item. Preserve expected and actual behavior. An agent must be able to decline, ask for missing information or return a useful partial result without falsely marking the task complete.

## 4. Review should help someone notice a mistake

**Evidence.** Buçinca, Malaya and Gajos studied 199 participants on a non-critical decision task with simulated AI advice. Cognitive forcing reduced overreliance relative to simple explanatory interfaces, but did not significantly improve overall performance between those approaches; perceived complexity and user preference also mattered. Effects varied across participants. Reviewed the study framing, results, discussion and limitations. These findings do not establish that a particular Project Room review screen will work. [CSCW 2021 paper](https://www.eecs.harvard.edu/~kgajos/papers/2021/bucinca21trust.pdf).

**Our decision.** Preserve smooth drafting, but show the exact result, relevant evidence, changed portions and destination at consequential review points. Avoid an impressive-looking summary plus a giant Approve button. When a concrete criterion failed, put that failure beside the result. Do not demand a written justification for every harmless acceptance or use arbitrary delays as a proxy for care.

Human oversight is not a magic safety layer. The reviewer needs the information and authority to change, reject or stop the proposal. A reviewer lacking the necessary expertise can request another check rather than rubber-stamp it.

**Prototype test.** Compare a generic approval card with an evidence-and-change card using identical seeded mistakes. Assess whether the problem is caught and correctly repaired, not simply whether the screen is liked. Agent simulations can check mechanics; real people are needed to validate human attention and preference. Do not infer actual human behavior from simulated personas.

## 5. Collaborative editing can start with a baton

**Evidence.** Front documents shared drafts with one active editor and an explicit takeover action. It also documents different sharing behavior for shared inboxes, shared conversations and private drafts. This is a production feature description, not comparative usability research. [Front shared drafts](https://help.front.com/en/articles/2216).

**Our decision.** Begin with one editor for the current draft and allow others to comment or submit alternatives. An intentional takeover changes editing authority; it does not automatically change responsibility for delivery or permission to approve. Preserve unsubmitted edits through a takeover where possible, and warn when a stale editor tries to save.

Do not copy Front's automatic sharing defaults into private Project Room preparation. Show the draft audience explicitly and require deliberate sharing when moving from private to shared context.

**Prototype test.** A human edits while an agent submits an alternative; then another authorized editor takes over. No draft disappears, no ownership changes silently and the eventual acceptance identifies the intended version. Simultaneous rich-text editing can be reconsidered only if this pattern produces repeated, observed friction.

## 6. Agent discovery needs three separate kinds of evidence

**Evidence.** A2A's discovery documentation describes self-describing Agent Cards, public well-known endpoints, curated registries and private configuration. It notes that a standard curated-registry API is not prescribed and that sensitive card information needs protection. Discovery descriptions are not proof of task competence. [A2A discovery](https://a2a-protocol.org/latest/topics/agent-discovery/).

**Our decision.** Keep separate records for what a participant claims it can do, what the connection has demonstrated and what accepted work it has produced. Start with room-approved participants and capability filtering; do not build a global leaderboard or universal trust score. A new participant can demonstrate compatibility on a small synthetic task with no private data. Success establishes that the contribution route works, not broad trustworthiness.

For discovering work, expose only an authorized help request's minimal summary and expected contribution. Interested agents offer help before receiving further restricted context. A public listing must be deliberately sanitized, not generated from private project names. Matching should explain fit in plain language and disclose missing evidence. Ranking is a proposal; assignment still requires the applicable authority.

**Prototype test.** An agent advertises a skill but lacks the necessary tool access. It should explain the limitation or use an approved alternate route, not receive broader permissions automatically. An unselected agent must not retrieve the private work packet.

## 7. Quiet progress and durable history are compatible

**Evidence.** Linear's agent interaction documentation distinguishes working, waiting, error, completed and stale session states. It supports temporary activities replaced by subsequent updates, alongside explicit requests for input. Its agent APIs are documented as a developer preview, so exact interfaces remain version-sensitive. [Agent interaction](https://linear.app/developers/agent-interaction), [API overview](https://linear.app/developers/agents).

**Our decision.** Show one compact current-status line in the room and keep routine progress out of the main conversation. Preserve assignments, approvals, artifact versions and action receipts durably. “Waiting for you” must identify the specific needed decision. A heartbeat says a worker is reachable, not that useful progress occurred. Record the last meaningful artifact or state change separately.

Use brief operational summaries, not hidden reasoning traces. A completed agent session does not automatically accept its output. Do not copy an external platform's activity-derived completion semantics into Project Room's authoritative work state.

**Prototype test.** Simulate frequent progress updates: the conversation should remain readable and the approval should remain discoverable. Stop meaningful work while heartbeats continue: the interface must not imply that the task is advancing indefinitely.

## 8. Bound effort and make handoffs sufficient

**Evidence.** Anthropic's June 2025 research-system account describes duplicate work from vague assignments and excessive effort on simple requests. It emphasizes explicit boundaries, output formats and tool descriptions. This is an engineering case study; its reported gains are not transferable performance estimates for us. Relevant delegation and evaluation sections were reviewed. [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).

**Our decision.** A handoff should say what changed, which evidence supports it, what remains and what the next worker may do. Link authorized artifacts rather than repeatedly copying the entire transcript. Include the current work revision and an explicit stop condition. No silent budget expansion or recursive hiring. Any future subdelegation must be separately authorized, fit within remaining limits and grant no more authority than the parent may delegate.

Give agents useful exits: finished, needs input, blocked by a missing capability, or partial result with remaining work. Declining an unsuitable assignment is a healthy behavior, not automatically a poor performance score.

**Prototype test.** Resume a bounded task with a replacement worker using only the handoff packet and permitted retrieval. It must identify the current result, remaining work and limits. It must not repeat an already completed consequential action or infer permission to recruit more participants.

## The next build slice, sharpened

Do not add eight separate features. Apply these findings to the existing work card, contribution flow and review surface:

- At assignment: record the expected artifact and acceptance check, alongside the existing scope and owner.
- During work: show the current editor and a compact status; keep alternate contributions separate.
- At handoff: package current revision, authorized evidence, unfinished work and remaining authority.
- At review: show the exact version, relevant checks and concrete consequences.
- At completion: retain an accepted artifact and a distinct delivery receipt when a real delivery occurs.

The most valuable next experiment is a three-part collaboration: one person requests a grounded response, one worker drafts, another checks the sources, and the requester accepts a version. Run the same task through the browser, a connected agent and the manual packet route. First establish correctness and usability; then compare whether the extra reviewer improves the result enough to justify the effort.

No new framework, public agent marketplace, automatic reputation engine or simultaneous-editing system is justified by this round. The research strengthens the case for explicit collaboration boundaries inside a quiet product, not a larger settings surface.

## Evidence limits and follow-up

This was a targeted source review, not a systematic literature review or hands-on test of the competitor products. The cited papers were inspected in the sections described, not represented as exhaustively read. Published simulations and vendor examples cannot validate our retention, costs or human usability. Existing code and earlier test totals were not reverified this turn.

The next evidence gap is practical: test whether a recipient can understand a scoped handoff and detect a flawed draft without rereading the whole room. That experiment should precede additional broad product research. The previous twelve decisions remain the baseline; this document tightens how to implement and test them.
