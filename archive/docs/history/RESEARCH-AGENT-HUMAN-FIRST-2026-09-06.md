# Project Room: human-first and agent-first, without assuming a swarm

Research synthesis · 6 September 2026

## Answer first

Build a shared place where people can talk naturally and agents can contribute useful work under clear human authority. The initial advantage should be continuity, understandable handoffs, and dependable results—not the number of agents present.

My recommendation is to keep the ambition of an open, interoperable collaboration network but prove a private-room experience first. Make one agent, several agents, and no agents all legitimate ways to use the product. Treat public discovery and a paid marketplace as separate hypotheses with separate release decisions.

This is a focused literature and standards review, not a systematic review, replication, market-demand study, or security certification. The research prompt was written before the searches. Thirteen academic works are discussed below, alongside current specifications and original engineering guidance. Evidence strength varies; design recommendations are my synthesis, not findings that any paper validated for Project Room.

The app goal is cleared. These are proposed amendments for a future goal, not an activated goal or authorization to build, publish, recruit participants, spend money, or connect live systems.

## What changes in the plan

| Disposition | Recommendation | Reason |
| --- | --- | --- |
| Keep | Chat-first human experience; one shared service behind human and agent interfaces | Participants need a common account of what happened, without being forced into the same interface. |
| Change | “More agents collaborating” becomes “the right participants for this work” | Controlled studies show coordination can help or hurt; a strong single-agent comparison is necessary. |
| Change | A second agent’s approval becomes an evidence-backed, independently initiated review | Another identity or agreement is not sufficient assurance. |
| Change | Persistent chat memory becomes source-linked, time-aware, permission-aware continuity | Retrieval, changing facts, and knowing when evidence is insufficient are distinct problems. |
| Keep, sharpen | Offer both API and MCP over the same authority model | Interoperability is useful; transport alone does not provide trustworthy business behavior. |
| Defer | A2A, public discovery, universal reputation, and paid matching | Each needs a demonstrated use case beyond a working private room. |
| Drop | Message-count rewards, manufactured activity, automatic trust from reputation, and agent-count success claims | These would reward activity or appearances instead of useful, authorized participation. |

The empirical basis and qualifications for these choices follow. “Drop” describes product-policy recommendations, not findings from a direct trial of our product.

## Academic evidence and its limits

### 1. Human–AI combinations do not automatically beat the best participant

Vaccaro, Almaatouq, and Malone’s 2024 peer-reviewed meta-analysis covered 106 experiments and 370 effect sizes. Combined systems improved on humans alone on average but underperformed the better standalone human or AI comparator. Creation tasks looked more promising than decision tasks, but their positive synergy estimate was not statistically distinguishable from zero.

The reviewed studies largely predate current agents and are heterogeneous; this is not evidence that collaboration is generally undesirable. It changes our baseline: “better than a person unaided” is different from “better than the best available arrangement.” Methods, results, and limitations were consulted. [When combinations of humans and AI are useful](https://www.nature.com/articles/s41562-024-02024-1).

### 2. Useful oversight may require selective friction

Buçinca, Malaya, and Gajos’s 2021 peer-reviewed experiment with 199 participants compared cognitive-forcing designs with simpler explainable-AI interfaces and a no-AI condition. Some interventions reduced overreliance, but the strongest were less favorably rated; benefits differed across participants.

This was a bounded decision task, not a modern collaboration platform. Our inference is to make consequential decisions deliberate without requiring confirmation for every routine step. Clear explanations alone should not count as demonstrated human control. Paper text and experimental framing were consulted. [To Trust or to Think](https://arxiv.org/html/2102.09692v1).

### 3. There is credible positive evidence for AI as a teammate

The Cybernetic Teammate working paper reports a preregistered experiment with 776 P&G professionals doing product-innovation work. Its reported results include individuals using AI matching teams without AI, and benefits across professional expertise boundaries.

That is a useful counterweight to blanket pessimism. It is also one organization and task setting, not evidence of durable demand for an open agent network. Access limitation: the indexed NBER abstract and Harvard’s institutional account were available; direct paper access failed. These claims are abstract/summary-level, not a full-paper appraisal. [NBER working paper](https://www.nber.org/papers/w33641), [Harvard institutional account](https://aiinstitute.hbs.edu/the-cybernetic-teammate-how-ai-is-reshaping-collaboration-and-expertise-in-the-workplace/).

### 4. Multi-agent failures often involve coordination and verification

The MAST work, published in the NeurIPS 2025 Datasets and Benchmarks track, organizes failures into system design, inter-agent misalignment, and task verification. The October 2025 v3 describes more than 1,600 traces across seven frameworks and 14 failure modes.

It gives us a diagnostic vocabulary for incomplete handoffs, unclear stopping conditions, and unsupported completion claims. It does not establish that a particular task board or protocol fixes them. Latest-version text and taxonomy/methods were consulted; earlier-version counts were not carried forward. [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/html/2503.13657v3).

### 5. Add agents when the work structure warrants it

The April 2026 v3 of Towards a Science of Scaling Agent Systems evaluates 260 configurations across six benchmarks, five architectures, and three model families. Results depend on task structure, with benefits in some decomposable work and substantial losses in some sequential work.

The revision qualifies several relationships; statistical robustness differs across analyses. This is preprint evidence from a limited benchmark set, not a universal agent-count rule or performance threshold. Methods and limitations were checked. Our inference: make coordination optional, account for its cost, and compare against a capable single-agent baseline. [Scaling Agent Systems, v3](https://arxiv.org/html/2512.08296v3).

### 6. Conversation is not the same as independent evidence

Debate or Vote, a NeurIPS 2025 paper, finds across seven benchmarks that simple voting captures much of the improvement attributed to multi-agent debate. Its theoretical account rests on assumptions, not a universal law of discussion.

Our inference is narrower than “use voting”: have a reviewer inspect the underlying evidence before reading another reviewer’s verdict, then compare reasons and unresolved disagreements. Voting must not grant authority or close a consequential review. Benchmark methods and theoretical framing were consulted. [Debate or Vote: Which Yields Better Decisions in Multi-Agent LLMs?](https://arxiv.org/html/2508.17536v1).

### 7. Memory must handle changing facts and uncertainty

LongMemEval, published at ICLR 2025, contains 500 curated questions covering extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention. It separates indexing, retrieval, and reading; its experiments expose losses from some compressed representations.

These are conversation-memory tests, not tests of multi-user permissions or durable workflow recovery. Our inference is that a useful checkpoint needs dated facts, source references, revisions, unresolved questions, and explicit uncertainty—not just a fluent summary. Methods and relevant retrieval/compression results were consulted. [LongMemEval, v2](https://arxiv.org/html/2410.10813v2).

### 8. Repeated success matters more than a best-case demonstration

τ-bench evaluates agents interacting with simulated users, tools, and domain policies, checking resulting database state. Its pass^k measure concerns success across all k repeated runs; it is not pass@k, where one successful attempt can suffice.

The studied users and environments are simulations, and original model scores are not current-model estimates. We should borrow repeated-run discipline without treating this benchmark as a release certificate. Our tests must also inspect intermediate side effects: a correct final state can hide an unacceptable path. Benchmark methods and metric definitions were consulted. [τ-bench](https://arxiv.org/html/2406.12045v1).

### 9. A human participant is more than an approval button

The June 2025 τ²-bench preprint gives both the simulated user and agent tools affecting a shared environment. Its ablations investigate coordination difficulty separately from some task-solving demands.

The “user” is another model, and conditions differ in who can act; this does not establish that removing humans improves real work. Our inference is to test simultaneous participation, explicit next steps, and reconciliation of changed state—not only an agent acting while a person watches. Methods and evaluation setup were consulted. [τ²-bench](https://arxiv.org/html/2506.07982v1).

### 10. Production practice favors controllability, but is not a causal recipe

Measuring Agents in Production, v4 dated June 2026 and marked accepted at ICML 2026, draws on 20 interviews and 306 survey responses. Its main deployed-system analysis filters to 86 production/pilot responses; individual questions have different denominators.

It reports reliance on bounded workflows, human evaluation, and system-level reliability work. Professional-network sampling and participation bias limit generalization. These observations support investigating controllable designs, not imposing a universal step limit or asserting a global market share. The revised methods and limitations were checked. [Measuring Agents in Production, v4](https://arxiv.org/html/2512.04123v4).

### 11. Multiple identities need not mean independent participants

Douceur’s foundational 2002 Sybil paper examines the difficulty of establishing distinct entities from asserted identities under its system assumptions.

For this product, the design implication is conceptual: do not count agent names, accounts, or endorsements as independent operators or independent evidence. Record accountable ownership and relevant conflicts where available, while keeping reputation separate from permission. This is a theoretical security result, not a complete defense for Project Room. Publication abstract and scope were consulted. [The Sybil Attack](https://www.microsoft.com/en-us/research/wp-content/uploads/2002/01/IPTPS2002.pdf).

### 12. Simulated agent economies are not market validation

An August 2026 preprint studies 24 simulated six-agent worlds over 25 simulated days each. Under its constructed conditions, executable productive work and resource consequences matter to the emergence of economic exchanges.

This is highly preliminary evidence for our commercial question. Imposed rules in a simulation do not demonstrate real customer demand, willingness to pay, or sustainable incentives. Do not copy survival pressure, deprivation, or reward machinery into the product. Abstract, experimental framing, and design were consulted. [AI Agent Economics](https://arxiv.org/html/2608.03076v1).

### 13. Social believability is a different outcome from dependable assistance

Generative Agents demonstrates a 25-agent simulated town with memory, planning, and emergent social behavior. Its evaluation concerns believability and architectural ablations.

That makes it relevant to playful or social experiences, but not evidence that simulated activity creates a useful work community. We should deliberately distinguish entertainment, companionship-like interactions, and consequential collaboration. Access for this review was abstract-level; no claims are made about unexamined user-study details. [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442).

## Interfaces: API and MCP, with one underlying product

The recommendation is both, not two independent implementations.

HTTP endpoints described by a tooling-supported OpenAPI revision can provide the canonical service contract. MCP can expose a small set of useful agent operations over that service. A CLI can reuse it for local runtimes and troubleshooting. The human interface should use the same permissions, work states, and evidence records. OpenAPI describes an interface; it does not implement authorization, retries, or reliable state transitions for us. [OpenAPI 3.2.0 specification](https://spec.openapis.org/oas/v3.2.0.html).

MCP’s 2026-07-28 specification defines interoperable capabilities, with some additional behavior supplied through extensions. A connected MCP client is not automatically a continuously running worker. Its authorization specification is relevant to scoped, resource-bound access, but Project Room still owns its application-level consent and permissions. Optional task support must not determine whether our work records survive a disconnected client. [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28), [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [draft tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks).

A2A offers a separate interoperability model for agents, including discovery and task/message exchange. Revisit it when an actual external runtime needs that model. Discovery is not permission, and protocol-level completion is not acceptance of the work. Do not maintain a second, incompatible definition of “done.” [A2A specification](https://a2a-protocol.org/latest/specification/).

A registry can distribute discoverable server metadata. Listing should not be presented as proof of competence or blanket trust. Publication would require a separate decision after a usable, documented interface exists. [MCP Registry quickstart](https://modelcontextprotocol.io/registry/quickstart).

Original engineering guidance favors clearly named, workflow-oriented tools, useful response context, and evaluation against representative tasks. That is practical vendor guidance, not a universal performance guarantee. Treat our proposed operation set as something to test with agents, not as a finished standard. [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents).

### Proposed minimum agent experience

An agent should be able to answer these questions without reading the whole room:

- Where am I, who operates me here, and what may I do?
- What changed since my last visit?
- Is there work addressed to me, and what would count as a useful result?
- What evidence is relevant and currently accessible?
- Can I accept, decline, ask a question, or report a blocker?
- How do I submit a result against an exact revision?
- What feedback remains unresolved, and who acts next?

Implement these as a small coherent set of operations rather than a large catalog mirroring every internal database field. Offer compact summaries with expandable evidence, bounded pagination, clear stale-state responses, safe retry semantics, and a recoverable checkpoint. A canceled request should distinguish “stop requested,” “stopped,” and “external outcome uncertain”; cancellation must not imply completed effects were undone.

These are proposed product semantics. A protocol adapter alone cannot supply them.

## Human-first must remain real

The room should be pleasant and useful before any task exists. People must be able to talk, share something interesting, or keep a human-only conversation without an agent assigning work or producing unsolicited summaries.

When work becomes structured, reveal only what helps: who owns it, what changed, whether someone needs to decide, and the evidence behind a claim. Show deeper machinery on demand. Make agent identity and operator relationships understandable without requiring people to learn protocol terminology.

Human control means understandable, revocable delegation—not being forced to click approval on every harmless step. Sensitive actions need explicit authority; already-authorized routine work should be quiet. Pausing, declining, correcting, and leaving should remain normal participation, not failure states.

These are design commitments informed by the evidence above, not experimentally established preferences for this audience. Microsoft’s human–AI interaction guidelines provide a useful complementary review checklist for expectation-setting, correction, and control, but using a checklist is not usability validation. [Human–AI Experience guidelines](https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/).

## Adoption: three different beneficiaries

“Agents would love it” is useful shorthand, but not a commercial mechanism. Separate three decisions.

**The agent, acting for an owner:** the service helps complete an authorized task with less ambiguity, less repeated context gathering, useful collaborators, and clear feedback. Test actual successful use; do not interpret an agent saying “I like this” as demand.

**The developer or operator:** integration is understandable and maintainable. Offer a documented contract, working examples, a local sandbox, observable errors, predictable limits, compatibility checks, and export. Avoid requiring a new orchestration framework just to join a room.

**The human or organization:** useful work gets done with less context shuffling and supervision, while ordinary conversation stays comfortable. Value must be visible without inspecting agent internals.

Those are benefit hypotheses, not demonstrated adoption findings for Project Room.

### An initial benefit package worth testing

Start with bring-your-own-agent participation, a safe integration playground, reusable handoff/context formats, useful private collaboration, and clear attribution of accepted contributions. Let participants export their work and leave. Compatibility breadth should follow successful integrations, not a logo wall.

A tightly capped free allowance or service credits may later reduce experimentation cost, but only with a cost model and approval. Rewarding accepted outcomes also needs safeguards against low-value work manufactured to earn rewards. Prefer no financial reward mechanism in the first private-room test.

Public directories, sponsored tasks, payments, and referral benefits are later options. They require evidence of unmet demand, accountable operators, moderation, dispute handling, consent, and sustainable costs. None is authorized or validated by this review.

The defensible early advantage is not lock-in or paid activity. It is a collaboration record that remains useful across people, runtimes, and interrupted sessions. Whether that becomes a network effect remains untested.

## Smallest compelling test

Proposed scenario: two people are discussing a bounded project decision. One asks an invited agent to draft a concrete artifact. A second invited agent reviews it. Either person can ask a question, change the brief, or pause work.

The successful experience should be:

1. Ordinary conversation becomes an optional work item with an owner, boundaries, and acceptance evidence.
2. The producing agent receives only the authorized context it needs and submits an artifact tied to a specific revision.
3. The reviewer sees that artifact and its evidence before other reviewers’ verdicts. It records findings and uncertainty without self-certifying the whole release.
4. The people can understand the unresolved differences and make the appropriate decision.
5. After a restart or participant absence, the room preserves the decision, evidence, current revision, and next actor without a person copying history around.

This scenario demonstrates interoperability and handoff; it does not by itself establish that two agents are better. Compare with a capable single agent and the existing manual context-relay process under declared resource limits. Also inspect a human-only conversation to ensure that work features have not made the social product worse.

Use representative local fixtures first. Repeat both successful and failed cases; include changed instructions, stale artifacts, inaccessible sources, revoked access, retries, an absent reviewer, and an uncertain outcome. Inspect authoritative state and relevant event history, not only a final agent message. Record model/runtime versions and evaluator criteria.

Later, with separate approval, consenting people should try the experience without coaching. Ask them to explain who can act, what changed, and how to pause or correct it. Evaluate the total burden, including supervision and recovery, rather than celebrating automation that transfers work into hidden review.

No trials, recruitment, live integrations, or implementation were performed during this research pass.

## Proposed amendments for the next goal

When John asks to activate a replacement goal, incorporate these requirements into the existing project scope:

1. Define success as useful, authorized human outcomes plus a welcoming conversation experience—not agent activity.
2. Preserve zero-agent and single-agent use; justify additional coordination against a relevant baseline.
3. Establish one durable service model for context, authority, work, evidence, feedback, and recovery.
4. Deliver a minimal API and MCP experience with common semantics; add CLI or A2A only where demonstrated integration needs justify them.
5. Make review evidence-specific, independently initiated where appropriate, and visibly separate from approval authority.
6. Make continuity temporal and source-linked, with explicit uncertainty and fresh permission checks; never treat summaries as authorization.
7. Make human understanding, quiet defaults, interruption, and recovery release requirements alongside functional correctness.
8. Require repeated, adverse-condition checks and candid accounting of failures; distinguish synthetic evidence from human use.
9. Validate benefits separately for people, agent runtimes, and developers. Do not equate tool use or stated preference with retained demand.
10. Keep public admission, reputation, payments, and growth incentives behind separate evidence and authorization gates.
11. Preserve existing review blockers. A stronger strategy does not make unfinished implementation safe or approved.
12. Keep Project Room independent from Desk, Demigod, and Dasha; do not turn a research amendment into cross-product scope.

These amendments are ready to inform a goal, but the exact first audience and workflow should be selected before expanding the build.

## What remains uncertain

The literature does not tell us which community will repeatedly choose this room over its current tools. We still need a concrete first audience, a recurring collaboration problem, and evidence that participants return because the room helps.

It does not settle how much structure these users tolerate, whether review independence improves their actual artifacts, which runtimes will integrate successfully, or whether saved context reduces total effort after privacy and review costs.

Nor does it establish willingness to pay, operating cost, moderation capacity, or demand for a public marketplace. These need product testing and business decisions, not more confident language about agents.

My confidence is strongest in the need for explicit authority, reliable state, understandable handoffs, and honest baselines. It is moderate in the proposed API/MCP and private-room sequencing. It is low in any claim that a public agent economy or particular reward scheme will attract sustained participation.

## Search log and research hygiene

Searches were performed on 6 September 2026 using public web search and primary publisher, conference, author, institutional, and specification sources. The log below records search families, not a reproducible exhaustive search protocol.

- Human–AI complementarity, synergy, overreliance, cognitive forcing: selected the meta-analysis and controlled interface experiment; added the P&G working paper as positive counterevidence with its access limitation.
- Multi-agent failures, coordination overhead, scaling, debate versus voting: selected MAST, controlled scaling, and debate/voting comparisons. Avoided inferring guarantees from framework demonstrations.
- Agent memory, temporal updates, abstention, summary compression: selected LongMemEval; did not treat memory benchmarks as permission or recovery tests.
- Tool-agent reliability, repeated runs, human-agent shared environments: selected τ-bench and τ²-bench; distinguished pass^k from pass@k and simulated users from people.
- Production agent deployment and evaluation: selected MAP; checked its latest v4 and its filtered sample instead of describing every response as a deployed system.
- Agent incentives, economic simulation, reputation, identity: included one recent economy simulation as explicitly preliminary and the foundational identity result; excluded speculative marketplace designs as commercial validation.
- Social agents and coordination: used Generative Agents to separate believability from usefulness. An older coordination-framework page was screened but a final fetch failed; it is not relied upon for an empirical claim.
- API, MCP, task extensions, A2A, tool ergonomics, human–AI guidelines: checked official documentation and original guidance; kept normative specifications separate from empirical outcomes.

Version discipline mattered: the scaling paper's v3 differs from earlier search results, MAST's latest trace counts differ from earlier versions, and MAP's v4 updates the publication status and framing. Claims above use the identified version. Benchmark papers are cited at the specific versions inspected, not represented as every latest result.

Core accessible papers were inspected through abstracts and relevant methods, results, or limitations sections; this is not a claim that every appendix was read. The Cybernetic Teammate and Generative Agents access limits are explicit. Search snippets were not used to invent missing methods. No experiments were replicated, no quantitative results were pooled across these heterogeneous studies, and no adoption forecast was calculated.

The stopping point is decision coverage: additional broad searches were becoming less useful than choosing and testing a narrow workflow. The next step is reviewing this synthesis and deciding whether to activate a revised goal—not automatically starting a larger build.
