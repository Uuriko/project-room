# Research agenda and method: deciding what is worth learning next

6 September 2026 · Prepared after agenda/method searches and before the focused alternatives-and-value search

## The research assignment

Act as a skeptical product researcher for Project Room. First identify uncertainties that could invalidate or materially change the product strategy. Then choose an appropriate way to investigate each uncertainty. Only then search for evidence.

The purpose is not to accumulate support for an agent-first/human-first platform. It is to discover whether a particular audience has a problem we can solve better than its available alternatives, what would make that improvement dependable, and which attractive ideas should be narrowed or abandoned.

The previous two passes established useful design considerations. They did not establish customer demand, differentiation, willingness to switch, willingness to pay, or production readiness. Those omissions now matter more than another general paper about collaboration.

## Stage 1: what should we research?

### Research-agenda inputs

A 2026 human–agent collaboration workshop paper proposes using remote human collaboration as a source of questions about awareness, trust, and common ground. It is an agenda/vision, not empirical validation of a product. It helps identify questions but cannot answer whether users want our implementation. [Yao et al., 2026](https://arxiv.org/abs/2602.05987).

Original product-discovery guidance recommends framing the problem before selecting a solution and prioritizing unknowns whose wrong answers would have substantial consequences. This is practitioner guidance rather than a controlled estimate of research effectiveness. [Nielsen Norman Group, 2024](https://www.nngroup.com/articles/7-tips-discovery/).

Combining those inputs with the unresolved questions in our prior memos yields this ordering. It is a reasoned priority list, not a calculated value-of-information model.

| Priority | Question and decision | What public research can establish | What remains outside this research |
| --- | --- | --- | --- |
| 1 | Can existing tools already support the proposed experience? Choose replacement, complement, or narrower component. | Documented capabilities, integration constraints, and plausible baselines. | Hands-on suitability, migration effort, and customer preference. |
| 2 | Does a bounded workflow create net value? Choose the first use case and evaluation. | Conditions behind benefits and failures in empirical studies; appropriate comparators. | Project Room's actual quality, time, cost, and supervision burden. |
| 3 | Where do ownership and consent become unclear across runtimes or organizations? Set boundaries. | Interaction concepts and documented permission models. | A complete implementation audit or legal determination. |
| 4 | Can an unfamiliar operator connect an agent and recover from failure? Prioritize interface work. | Existing interfaces and recurring integration difficulties. | Compatibility and usability of our untested adapters. |
| 5 | Why would people return or contribute? Choose an initial community and benefit package. | Relevant mechanisms and counterexamples, not retained demand. | Interviews, observations, and repeated voluntary use. |
| 6 | Is public discovery or payment needed? Decide whether to expand. | Risks, alternative mechanisms, and hypothetical economics. | Sustainable demand, operating costs, moderation capacity, or willingness to pay. |

This pass will focus on priorities 1 and 2, with limited attention to permission constraints in priority 3. The remaining questions stay visible rather than being “answered” with generic literature.

### Hypotheses to challenge

H1: Providing chat, agent access, and an API is meaningfully differentiated.

Potential disconfirmation: existing platforms document those capabilities. That would move differentiation toward a specific cross-participant workflow, not prove that no opportunity exists.

H2: Faster model output or enthusiastic users imply lower total work.

Potential disconfirmation: measured end-to-end effort increases, review costs absorb the gain, or self-reported speed differs from observed completion time.

H3: A new destination is necessary to deliver continuity and clear handoffs.

Potential disconfirmation: an existing chat surface plus a narrow shared service can deliver the same result with less switching cost.

H4: A favorable study in another occupation or tool environment predicts this product's effect.

Potential disconfirmation: benefits change with task structure, expertise, context availability, quality requirements, or participant selection.

## Stage 2: how should we research better?

### What the methodological sources change

PRISMA-S describes transparent reporting of searches, including exact strategies, sources/platforms, dates, restrictions, and deduplication. It is a reporting guideline, not proof that a review is exhaustive or unbiased. I will borrow those practices without claiming PRISMA compliance. [Rethlefsen et al., 2021](https://link.springer.com/article/10.1186/s13643-020-01542-z).

Wohlin's software-engineering guidance explains backward/forward citation searching and emphasizes a diverse starting set. The method can miss disconnected research communities when seeds are narrow. I will use targeted follow-up searches for updates and contrasting evidence, not claim an exhaustive citation-network review. [Wohlin, 2014](https://www.wohlin.eu/ease14.pdf).

Cochrane's updated rapid-review guidance is a reminder that accelerated reviews involve explicit methodological choices. This product memo is not a Cochrane rapid review: no information specialist or independent second screener has been involved. The accessible methods-group overview and indexed recommendations were consulted; direct BMJ access failed. [Cochrane methods guidance](https://methods.cochrane.org/rapidreviews/cochrane-rr-methods).

The agent-evaluation analysis in AI Agents That Matter distinguishes downstream usefulness from benchmark performance and emphasizes cost-aware, reproducible comparisons. Its empirical settings do not establish our product's value. It motivates inspecting evaluation design, not transferring historical leaderboard scores. [Author research page](https://agents.cs.princeton.edu/).

### Operational method for the next search

1. **State the decision before the query.** Every included source must bear on an explicit hypothesis or comparison. Interesting but irrelevant papers go to the deferred list.
2. **Use different evidence for different claims.** Official documentation can establish a documented feature. A trial can estimate an effect under its conditions. A vision paper can suggest questions. None substitutes for the others.
3. **Search for disconfirmation deliberately.** Include existing alternatives, slowdown or null results, revised studies, limitations, and simpler baselines.
4. **Track exact search strings.** Record the applied queries and date in the companion memo. Web search is not a comprehensive bibliographic database search; do not invent hit totals or screening counts.
5. **Prefer primary sources and inspect the relevant details.** Read methods, comparators, outcomes, and limitations where accessible. Label abstract-only evidence and distinguish publication dates from crawl dates.
6. **Check study and version identity.** A preprint, conference paper, institutional summary, and press story can all represent one study. Do not count them as independent confirmations. Prefer updated interpretations when the authors report new limitations.
7. **Keep findings separate from inference.** Use explicit labels: documented capability; observed result; author interpretation; our product hypothesis; still unknown.
8. **Challenge the measurement.** Inspect denominators, assignment mechanism, recruitment, task difficulty, time horizon, quality checks, supervision, and whether apparent benefits persist after accounting for costs.
9. **Treat missing documentation cautiously.** “Not established by the pages inspected” is not “the product cannot do it.” Feature parity and workflow parity are also different.
10. **Recheck consequential claims.** Read the source supporting a claim again before using it to change the recommendation. A self-check is not independent review.
11. **Stop at a decision-relevant limit.** Once public evidence narrows the alternatives and identifies the needed local test, do not use more generic searching to imply the local uncertainty has disappeared.
12. **Keep authority separate from research.** No installations, live connections, recruited participants, posting, payments, code changes, or replacement-goal activation are authorized by this assignment.

### Evidence card for each core result

Record:

- Question/hypothesis addressed.
- Source, date/version, and study family.
- Source type and access depth.
- Population/task or documented product capability.
- Comparator and measured outcome, if applicable.
- Finding without extending its scope.
- Main limitations and likely transfer obstacles.
- What would change in our plan.
- What it does not establish.

Do not collapse these into a single numerical “evidence score.” Strong internal validity with weak relevance is different from direct product relevance with weak causal identification.

### Synthesis discipline

Do not pool unrelated productivity percentages or average across different occupations. Do not describe a result as a current-model estimate when the study used earlier tools. Distinguish lack of statistical evidence from proof of no effect.

Keep positive and negative findings together. If both can be explained by task, setting, or study design, say so instead of choosing the more convenient headline.

For product comparison, use a few representative baselines: an incumbent workplace platform, a community platform, and a topic-structured collaboration alternative. This is a purposive comparison, not an exhaustive market map or a purchasing recommendation.

Use the outcome of the research to refine the next decision. A source should not automatically add a feature to the roadmap.

## Deliverable and stopping condition

Produce a companion memo on existing alternatives and measured workflow value, with a concise capability comparison, evidence cards, an exact applied-query log, counterevidence, and revised hypotheses.

A successful pass may conclude that a proposed differentiator is already common, that a result cannot generalize, or that the next useful evidence requires a bounded local comparison. Those are valuable research outcomes.

End with a clear account of what changed, what did not, and what remains uncertain. Preserve previous documents and all existing implementation work. The app goal remains cleared.
