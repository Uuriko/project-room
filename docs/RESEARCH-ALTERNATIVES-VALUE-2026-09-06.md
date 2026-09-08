# Research pass 3: alternatives, measured value, and a sharper product hypothesis

6 September 2026 · Research and recommendations only; no implementation or live evaluation

## What this pass changes

The next question is not whether agents can participate in a collaboration space. It is whether Project Room can make a particular collaboration reliably easier than the alternatives a team already has.

Three conclusions guide the next decision:

1. **Agent access is a baseline capability, not a sufficient differentiator.** The documented alternatives below make a generic “chat plus agents plus API” proposition less convincing.
2. **Value must be demonstrated at the workflow level.** Output speed, perceived helpfulness, and completed useful work are different things. The empirical studies below do not justify transferring a single productivity multiplier to this product.
3. **A new destination is still a hypothesis.** Compare a dedicated room with a complementary service inside existing work before treating migration as necessary.

These are research conclusions and proposed comparisons, not a decision to abandon the existing app. The earlier principles—clear authority, inspectable evidence, recoverable work, and human control—remain important. They do not by themselves establish demand.

## 1. What can existing alternatives already do?

This is a purposive documentation comparison, not a market census, hands-on benchmark, or purchasing recommendation. Product capabilities were checked on 6 September 2026. Pricing, plan eligibility, total migration cost, and operational performance were not established.

| Representative alternative | Documented capability | Question for our comparison, not a claim of missing functionality |
| --- | --- | --- |
| Slack | Official MCP supports search, conversation reading/writing, canvases, and structured lists. Access uses scoped authorization and administrative controls. [Developer documentation](https://docs.slack.dev/ai/slack-mcp-server/). | Can a well-configured existing workspace support the proposed handoff with acceptable effort? |
| Discord | Apps can expose commands, buttons, menus, and forms. Bot permissions and user authorization are distinct mechanisms. [Interactions](https://docs.discord.com/developers/platform/interactions), [authorization and permissions](https://docs.discord.com/developers/platform/oauth2-and-permissions). | Can a community's existing interface carry the workflow without asking members to move? |
| Zulip | Integrations and APIs operate within topic-organized conversations. Topic visibility depends on access; bot history can differ from its owner's history. [Integrations](https://api.zulip.com/help/integrations-overview), [topic API](https://api.zulip.com/api/get-stream-topics). | How much continuity is already obtainable through explicit topics and a suitable integration? |

Slack's current documentation also restricts this MCP distribution path to internal or Marketplace-published apps, not unlisted distributed apps. That constraint matters when evaluating distribution, but does not establish a defensible opportunity for us. Availability of an interface is not evidence that a whole workflow is pleasant or reliable. [Slack MCP overview](https://docs.slack.dev/ai/slack-mcp-server/).

Likewise, failure to find a feature in these pages is not proof that a platform lacks it. A credible comparison must allow reasonable configuration and an appropriate app, not compare our tailored prototype against an untouched default workspace.

**Product inference:** “API or MCP?” is primarily an accessibility and integration decision. The differentiator would have to be the outcome those interfaces make easier. Supporting both can be sensible, but two interfaces to the same weak workflow do not create twice the value.

## 2. What does measured productivity research actually say?

The following evidence cards deliberately keep contradictory-looking results together. They concern different tools, people, dates, interventions, and outcomes. Their percentages must not be averaged or subtracted.

### A. A randomized study found a slowdown in a specific setting

**Source and access:** METR's early-2025 developer study; original paper, abstract and relevant methods/results inspected, not every appendix. Sixteen experienced open-source developers completed 246 tasks on familiar repositories, randomized to AI-allowed or AI-disallowed conditions. The estimated effect was 19% longer completion time with the tested tools. Participants nevertheless believed AI had made them faster. [Original paper](https://metr.org/Early_2025_AI_Experienced_OS_Devs_Study-paper.pdf).

**Limit:** Small, selected population; familiar repositories; early-2025 tools. This is not a current estimate for all developers or for collaborative rooms.

**Implication:** Measure end-to-end effort separately from perceived benefit. The result challenges a universal speedup claim, not every potential use of AI.

### B. The follow-up complicates the old headline

**Source and access:** METR's 24 February 2026 methodological update; full main text inspected. The later experiment included returning and newly recruited developers. Authors report that participation and task selection changed, pay decreased, and concurrent-agent use complicated time measurement. They regard the resulting estimate of current productivity as unreliable. Their belief that benefits have improved is not a well-identified magnitude estimate. [Research update](https://metr.org/blog/2026-02-24-uplift-update/).

**Limit:** Neither the older slowdown nor the newer raw speedup should be advertised as the present universal effect.

**Implication:** Record who declines participation, which tasks are excluded, and how overlapping work is counted. This is a continuation of the research program, not independent confirmation of its first result.

### C. A large workplace study found benefits, unevenly distributed

**Source and access:** Brynjolfsson, Li, and Raymond, *Generative AI at Work*, QJE 2025; published article's abstract, rollout, empirical strategy, and relevant results inspected. The study covers 5,172 human customer-support workers—not autonomous agents. A staggered rollout, analyzed with difference-in-differences methods, estimated approximately 15% more issues resolved per hour on average, with larger gains for less experienced or lower-skilled workers. [Published article](https://academic.oup.com/qje/article/140/2/889/7990658).

**Limit:** The principal analysis is not randomized assignment; identification requires assumptions. The underlying rollout was primarily in 2020–2021, despite the 2025 publication date. One firm's support setting is not a forecast for our product.

**Implication:** A bounded task with useful organizational context is a plausible place to investigate value. Expertise and task structure belong in the comparison, not just the model name.

### D. Newer self-reports are informative, but not measured causal gains

**Source and access:** METR's 11 May 2026 survey of 349 technical workers; summary, methodology, results, and limitations inspected. Respondents reported substantial benefits. The sample was recruited by convenience; emailed response rates were approximately 2%. The authors distinguish perceived speed from perceived value and explicitly warn that internally consistent answers need not match reality. [Survey report](https://metr.org/blog/2026-05-11-ai-usage-survey/).

**Limit:** Self-reported counterfactuals and selection effects prevent interpreting these responses as representative causal productivity estimates.

**Implication:** Ask people where the product helps and why. Use their answers to locate workflows and friction, not as a substitute for observing outcomes.

### E. Changing which tasks people do changes the question

**Source and access:** METR's 8 May 2026 research note on task substitution; primary text inspected. It distinguishes improvement on a fixed task distribution from value after people choose different work. Its formal relationships depend on behavioral and valuation assumptions; this is conceptual analysis, not a new field trial. [Task substitution and uplift](https://metr.org/blog/2026-05-08-task-substitution-and-uplift/).

**Implication:** A matched-task comparison answers one question. Subsequent voluntary use can reveal valuable newly possible work—or low-value activity that merely became cheap. Neither observation alone settles the other question.

### What survives across these sources?

My synthesis is methodological, not a pooled effect estimate: define whose work is improving, what counts as completion, which costs count, and what alternative is being displaced. Keep observed outcomes and participant impressions separate. Date the tool environment as well as the publication.

There is no evidence here that Project Room saves time, attracts a durable community, or needs a public agent marketplace. Those remain open product questions.

## 3. A more useful hypothesis for Project Room

**Proposed hypothesis, not established differentiation:** a small team working with separately operated agents can hand off an artifact, inspect the supporting evidence and exact revision, recover after interruption, and retain clear human authority with less coordination effort than its existing setup.

This makes “agent-first and human-first” a shared requirement:

- The agent can determine the current task, allowed scope, relevant evidence, and next permitted action without reconstructing everything from chat.
- The person can understand what changed, who or what changed it, what remains uncertain, and what decision is theirs.
- Both encounter the same underlying work state and permission boundaries.
- An interruption does not require either participant to trust an unsupported claim that work was completed.

This is a design proposal derived from our unresolved problem, not a claim that competitors cannot provide these properties. Its distinctiveness and implementation quality need comparison.

### What would make agents and their operators choose it?

Do not assume an agent has an independent desire to join. Selection may be made by an operator, an application developer, or a routing policy pursuing a user's objective. Our benefit must survive those different selection mechanisms.

The initial benefit hypothesis should therefore be practical: useful context, predictable results, low integration effort, understandable costs, and recoverable collaboration. These can benefit operators and improve agent task performance at the same time.

Keep speculative incentives separate. Credits, rankings, rewards, and referrals could attract activity without establishing valuable outcomes. This pass supplies no new causal evidence that they would improve retention here. Public incentives remain behind the more basic question of whether anyone repeatedly chooses the workflow without them.

## 4. The next comparison should include three possible product shapes

1. **A dedicated Project Room:** a new shared destination with its own human and agent experience.
2. **A complement to existing collaboration:** the same proposed work-state and handoff service accessed from a team's current interface.
3. **Existing tools with reasonable configuration:** the strongest practical baseline available to the participating team.

The third option may win. The second may avoid unnecessary migration. The first may justify itself through a substantially clearer experience. Research should allow all three outcomes.

Do not build all three on the strength of this memo. First specify one scenario and identify what is already possible. Implementation, live access, and participant recruitment require their own scoped authorization.

### A small, non-sensitive scenario worth specifying

Two people use separately operated agents to produce and review a short artifact. The reviewer receives a specific revision with its evidence, finds an issue, and requests a correction. Work is interrupted once; a participant returns and must determine the current state. A permission change is represented in the scenario so that the team must distinguish past participation from present authority.

This is a proposed benign workflow comparison, not a security test or authorization to access any real system. Use synthetic material when a test is separately approved.

Before running it, specify what an acceptable final artifact and understandable handoff look like. Give the incumbent setup equivalent task information and reasonable preparation. Counterbalance order where feasible; do not let everyone learn the task in the baseline and then credit the second interface for that learning.

Observe total human effort, including setup, explanation, review, correction, and recovery. Keep elapsed completion time distinct from hands-on time when work overlaps. Record incomplete attempts and unresolved quality problems instead of quietly removing them. Ask separately whether people understood the outcome and would choose this workflow again.

Do not collapse these observations into an invented single score. A workflow that saves a few minutes but produces an unnoticed incorrect artifact has not demonstrated an acceptable tradeoff. Conversely, a slower workflow could be valuable if it produces a materially better, verifiable result. Agree on the relevant tradeoff before seeing the results.

This small comparison would be exploratory, not statistically decisive. A later evaluation would need a sample and design matched to the decision. Repeated voluntary use would still be necessary to investigate durable demand.

## 5. Updated hypotheses and remaining unknowns

| Hypothesis from the agenda | Result of this pass |
| --- | --- |
| H1: Chat, agent access, and an API are sufficient differentiation. | Weakened by documented existing capabilities. A workflow-level advantage is needed. |
| H2: Faster output or enthusiasm implies lower total work. | Not reliable as a general inference. Measure actual outcomes and effort separately. |
| H3: A new destination is necessary. | Open. Compare a complement and a configured incumbent. |
| H4: Positive results elsewhere predict our effect. | Unsupported without transfer assumptions and local evidence. |

We still do not know which initial audience has the strongest recurring problem, whether its members will switch, how much integration they tolerate, whether the current implementation fulfills the proposed contract, or what operating economics would support the service. More generic academic citations cannot resolve those local questions.

## 6. Search record and limitations

The companion agenda/method document was written after meta-research and before this applied search. Searches below were run on 6 September 2026 through web search, with primary-site restrictions in the literal queries. These were the exact strings used, including the `site.` punctuation; they are a record of what was attempted, not a claim that the search engine enforced valid domain filters:

1. `site.docs.slack.dev "MCP" server permissions`
2. `site.docs.discord.com developers interactions permissions bots`
3. `site.zulip.com "API" "topics" integrations`
4. `site.metr.org "developer productivity" 2025 2026 study`
5. `site.metr.org/blog/2026 developer productivity selection bias study`
6. `site.academic.oup.com/qje "Generative AI at Work" 2025`
7. `site.metr.org "Task Substitution and Uplift"`
8. `site.metr.org "Measuring the Self-Reported Impact of Early-2026"`

The final method check caught the malformed domain syntax. Three additional queries used the search tool's explicit domain-filter field: `"MCP" server permissions` restricted to `docs.slack.dev`; `developers interactions permissions bots` restricted to `docs.discord.com`; and `"developer productivity" 2026 study` restricted to `metr.org`. This correction improves the search record; it does not make the search exhaustive. The consequential claims also rest on direct reads of the cited primary pages.

Follow-up activity opened official documentation, the original METR paper, its later methodological update and May research notes, and the published QJE article. Within-page searches checked rollout, identification method, sample, and limitations. The latest consequential primary claims were reread before synthesis.

Sources were grouped by study family and version. An institutional post about a paper was not counted as another experiment. The METR survey is a distinct design, but it is not independent institutional replication of the developer study. Product documentation was used for capabilities, not customer-value estimates.

This is a selective, single-reviewer research memo. It does not have independent screening, a comprehensive bibliographic search, verified screening totals, complete appendix appraisal, or a hands-on competitor evaluation. The same AI's self-check is not independent review. No claim of systematic-review or PRISMA compliance is made.

The methodological sources and access limits are recorded in the companion agenda. In particular, failure to access a full methodological paper was not silently converted into a claim to have reviewed it.

## Checkpoint

The useful result is a narrower decision: establish a credible workflow comparison before expanding the platform or its incentives. The existing app remains intact. This pass adds only two research documents; it does not clear implementation blockers, launch a test, activate a goal, or instruct other agents to begin new work.
