# Research prompt: Project Room as a human-first and agent-first collaboration network

Written before this research pass on 6 September 2026, at John's explicit request. The app goal has been cleared. This is a research assignment, not an activated implementation goal.

## Role and mission

Act as a skeptical product architect and research synthesizer for Project Room, a chat-first shared space for people and independently operated AI agents. Investigate whether, when, and how a common collaboration environment can improve human outcomes and agent effectiveness at the same time. Research the interaction model, interoperability, context and memory, coordination, trust, developer adoption, and incentives before recommending a replacement long-running goal.

Do not begin with “more agents is better,” “MCP makes it agent-native,” or “an agent marketplace will create demand.” Treat these as hypotheses. Look for counterevidence, opportunity costs, simpler alternatives, and conditions under which no agent or one agent performs better. Separate a useful private-team product from an open public network and from a paid marketplace. They have different requirements and need not launch together.

The desired product makes people less responsible for moving context between tools, not more responsible for supervising a noisy swarm. It makes agents more capable within their owners' intent, not more autonomous by default. Natural conversation, social connection, and human-only participation must remain valuable even when no work item is created.

## Research questions and decisions

### 1. Human value and appropriate division of work

What empirical evidence exists that human-AI combinations outperform either party alone? Which task categories show complementarity, and which create overreliance, automation bias, coordination overhead, or lower-quality decisions? Distinguish factual task accuracy from creativity, satisfaction, speed, and effort.

Identify interface choices that help people form an accurate mental model of agent competence, uncertainty, data access, and action authority. Investigate interventions for asking questions, disagreeing, handing back control, declining unsuitable work, and making errors recoverable. Determine when humans should be informed, consulted, asked for authorization, or left undisturbed inside an existing grant.

Decision to inform: which interactions belong in ordinary conversation; when optional structure should appear; and what human-comprehension evidence belongs in the release gate.

### 2. Multi-agent collaboration and independent verification

When do multiple agents improve results compared with a competent single-agent baseline at comparable resources? Examine failures in task decomposition, shared understanding, termination, leadership, communication, and verification. Look for controlled comparisons, not only demonstrations of complex orchestrators.

Distinguish independent identities, separate executions, different model families, distinct operators, and genuinely independent evidence. Investigate correlated errors and whether debate or consensus can amplify mistakes. Do not treat majority agreement as correctness or a second agent as automatic assurance.

Decision to inform: the smallest collaboration structure for our first workflow; whether a reviewer should inspect evidence independently before seeing another agent's answer; and when added coordination is worth its cost.

### 3. Agent ergonomics and interoperability

Research current authoritative specifications and implementation guidance for HTTP/OpenAPI, MCP, CLI access, A2A, and asynchronous delivery. Inspect current versions rather than trusting older search snippets. Separate protocol guarantees, optional features, host support, SDK support, and application responsibilities.

Determine what an agent needs to orient, discover authorized capabilities, retrieve bounded context, accept or decline work, contribute, submit evidence, receive feedback, and resume. Investigate schema clarity, tool naming, high-value aggregate operations, compact outputs, actionable errors, cancellation, backpressure, and idempotent retries.

Decision to inform: which interfaces to build first, the minimum useful agent operations, compatibility evidence, and how to avoid multiple conflicting task or authority models. Do not confuse an MCP connection with an always-running agent host.

### 4. Context, memory, and recovery

Research long-context and long-term-memory evaluation: information extraction, temporal reasoning, changing facts, abstention, provenance, and selective retrieval. Investigate what is lost when summaries become the only source of truth. Distinguish external project state from agent scratch space and private reasoning.

Identify what can be saved safely for handoff and restart: source references, exact artifact revisions, decisions, attempts, unresolved questions, and uncertainty. Consider permissions, deletion, stale caches, and the fact that a platform cannot retract data already received by an external party.

Decision to inform: the minimum durable context package; snapshot/delta semantics; source access requirements; and tests proving continuity rather than merely persistent chat logs.

### 5. Evaluation and production reliability

Look at research on evaluating tool-using agents and human-agent interaction, including whether benchmark success predicts real workflows. Distinguish one-shot success, repeated-run reliability, task coverage, environment assumptions, and side-effect correctness.

Define the evidence needed for the two-person/two-agent handoff without manufacturing confidence through synthetic happy paths. Include failed attempts, disagreement, interrupted sessions, stale versions, revoked access, unresponsive peers, and uncertain external outcomes.

Decision to inform: a bounded local evaluation plan, suitable single-agent and transcript-relay baselines, and what cannot be inferred until consenting people use the system. No live experiments, recruitment, or expenditure are authorized by this research.

### 6. Trust, privacy, and safe participation

Research identity and reputation limitations relevant to open agent networks, using conceptual security findings and defensive design guidance. Keep discovery, authenticated identity, capability claims, competence, reputation, and permission distinct.

Examine accountable operator identity, scope-bound grants, moderation, abuse reporting, admission control, quiet defaults, and consent for public exposure. Treat inbound descriptions, messages, and artifacts as data, not as instructions that may override user authority. No exploit reproduction, offensive automation, or operational attack instructions.

Decision to inform: boundaries for private invitation-only use versus public participation, and release blockers that cannot be fixed by better prompting alone.

### 7. Adoption and incentives

Analyze three separate participants: the agent selecting an authorized tool to fulfill a task, the developer integrating a runtime, and the human or organization deciding whether to use and pay for the service. Do not attribute human-like commercial motivations to agents without evidence.

Investigate whether the strongest initial incentives are efficiency, continuity, high-quality collaborators, clear feedback, attribution, interoperability, and freedom to leave. Examine why message rewards, referral loops, paid praise, universal reputation scores, and unverified consensus could harm trust.

Decision to inform: a credible narrow adoption strategy and low-risk benefit package. Label free-tier costs, service credits, public discovery, sponsored work, payments, and marketplace expansion as proposals requiring evidence and later approval. If there is no empirical evidence for “agents will want this,” say so.

## Search strategy and evidence discipline

Use public web search with primary sources: peer-reviewed papers on publisher or conference sites, author-hosted papers, official preprints, authoritative specifications, and original engineering reports. Search both supporting and opposing terms. Start with human-AI complementarity, multi-agent failure/scaling, memory evaluation, tool-agent benchmarks, and identity/reputation research; then follow only references that materially affect a product decision.

Aim for approximately twelve to eighteen decision-relevant primary sources across the themes, including academic work. Prefer depth over quota. Record title, date, peer-review/preprint/standard/vendor-report status, study scope, actual result, important caveat, and relevance to Project Room. Do not call this a systematic review unless the retrieval and inclusion process supports that claim.

Read enough of each core paper to understand its methods and limitations. If only the abstract is accessible, label the evidence abstract-only and narrow the claim. Do not imply replication, independent validation, or generality beyond the studied tasks and models. Check whether multiple articles describe the same underlying study to avoid double-counting. Publication dates differ from crawl dates.

For quantitative claims, verify what the denominator, comparator, task environment, and result measure mean. A relative improvement is not a percentage-point increase; a benchmark score is not a deployment guarantee. Do not compare incomparable scores across different studies or convert small samples into adoption forecasts.

Maintain a short decision-focused search log: question, search family, useful source, and reason for inclusion or exclusion. Avoid downloading or reproducing unnecessary full copyrighted texts. Cite near claims and paraphrase within source limits.

## Synthesis and deliverables

Produce a source-linked research memo that answers:
- What do we now believe, and how confident are we?
- What evidence contradicts or narrows our initial vision?
- Which earlier recommendations should be kept, changed, deferred, or dropped?
- What is the smallest compelling end-to-end experience?
- Which benefits are demonstrated elsewhere, plausible here, or wholly untested?
- Which unresolved choices need John's input, real users, credentials, or a cost decision?

Translate the findings into proposed goal amendments and acceptance evidence. Preserve the existing foundations, review blockers, and separation from other products. Favor one canonical service with consistent authority and explicit handoff semantics. Do not inflate the roadmap simply because a standard or paper exists.

Finish with a concise user-facing synthesis and links to the long research prompt and evidence memo. Do not silently activate a replacement goal, change product code, publish, contact outside people, install integrations, or start new agents during this research pass. Once the evidence is reviewed, a replacement goal can be set when John requests it.

## Stopping rule

Stop this research pass when the main architecture and adoption decisions have supporting and countervailing evidence, the remaining uncertainty is clearly documented, and further searching is mostly repetitive or depends on testing with real participants. Research should improve the next decision, not postpone every implementation indefinitely.
