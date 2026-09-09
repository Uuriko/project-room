# Project Room

## Research & plan, version 2

48 new questions. Eight decisions reconsidered. Seven adjacent products.

Prepared for John Potter | 7 September 2026

**Build a place where people and their agents can make clear commitments, work without getting in each other's way, and return something useful.** Keep that experience worthwhile without paid AI. Sell optional help, not permission to continue collaborating.

Version 2 adds deeper evidence, collision prevention, bring-your-own agents, a Room-hosted assistant, sustainable free/paid boundaries, payment exceptions, and documented product walkthroughs. Version 1 remains the baseline and is preserved separately.

**Confirmed:** Room will collect and distribute ordinary payments and stablecoins through John's existing US-registered Stripe account. Account registration does not establish Connect configuration, stablecoin-payout approval, recipient eligibility or legal clearance.

This is a proposal and research record, not implementation, deployment, a payment launch, legal advice, or a claim of validated demand. Browser exploration was public and read-only; no accounts, trials, claims, payments or connected services were created.

<!-- pagebreak -->

## 1. The revised product thesis

### A useful room first; extra help second

The core is a shared place to understand a request, agree who will do what, preserve the result, and decide what comes next. A person should be able to use it alone, with another person, with their existing agent, or with optional hosted help. None should require a marketplace, a company hierarchy or a workflow diagram.

The first job should be **a real cross-tool handoff that currently needs too much clarification and follow-up**. A reproducible evaluation remains a candidate, but not a predetermined niche. A documentation change, independent evidence check or bounded product investigation might expose the same problem more cheaply.

### What changes from Version 1

- Preparation becomes first-class: an unclear request can end in a workable brief or a useful decision not to proceed.
- Coordination becomes explicit: responsibility, temporary write authority and integration are different things.
- The free workspace must survive exhausted AI credits, disconnected agents and plan changes.
- Review should make checking easier, not merely add more reviewers or confirmation screens.
- Financial obligations survive failed payouts, abandoned rooms and operator absence.
- Agent usefulness includes a precise question, a justified decline, or a well-supported stopping point.

### The smallest coherent experience

**Talk → agree → contribute → review → continue.** Payment, when agreed, has a parallel lifecycle. The interface shows the current result and next decision; details open when needed.

This is an inference from the research, not a proven advantage. Braintrust already offers structured human review, and Langfuse documents skill/CLI, MCP and API routes for evaluation work. Room should connect to such tools where useful, not rebuild an evaluation engine just to demonstrate agent support. [Braintrust, Set up human review](https://www.braintrust.dev/docs/annotate/human-review), [Langfuse, Agentic access](https://langfuse.com/docs/evaluation/agentic-access)

<!-- pagebreak -->

## 2. Where the project actually stands

### Source, live site and research are separate

The canonical checkout was clean when inspected: **c9b04e8**, on the unified local branch. The recorded live staging version remains **7084dd4**. No application change or deployment occurred in this research pass, and no new live acceptance is claimed.

Version 1 records 221 core/client checks, 56 browser scenarios, six Cloudflare checks and three remote CI jobs. These are historical checkpoint results, not suites rerun for Version 2. Likewise, earlier agent-operated artifact/review exercises establish a bounded route, not independence across organizations or universal interoperability. Human journeys remain simulated.

### Reuse the foundation already present

Room already has work revisions, durable events, exact-result evidence, reviews, owner decisions and a documented HTTP client. Its client contract tells agents to refresh stale work and reconcile a lost response using the original command identity. Read operations do not themselves acknowledge responsibility or authorize external actions.

Write-mode work also has a claim with holder, repository, reference, paths and expiry. The inspected acquisition function checks the selected work item's existing claim. That is useful groundwork, but **not evidence of cross-work resource arbitration or control over an external agent's actual file writes**. The existing database writer-fence tests address obsolete application writers, not every agent's ownership generation.

### Important proposed capabilities are still proposed

Task-scoped external access, cross-task collision handling, a hosted Room assistant, a paid bounty ledger, live Stripe payouts and a Dasha execution adapter are not established by this report. Current Room membership remains broader than a minimal assignment-only context grant.

Dasha should remain an execution service. Before dispatch integration, its owner must confirm durable lookup after response loss, deduplication scope, cancellation behavior, retained results and measured versus unknown usage. A cancellation request must not become a promise of stopped compute or charges.

Local evidence: current project handoff, unified agent-client contract, work event reducer, workflow tests and database writer-fence tests. Inspection was read-only and scoped; this was not an exhaustive code audit.

<!-- pagebreak -->

## 3. What deeper evidence changed

### Compare against capable alternatives

Dell'Acqua and colleagues' published 2026 P&G field experiment involved 791 professionals. Individuals with AI matched teams without AI; AI improved generated ideas, while selection did not improve in the same way. Its one-day, one-company, cross-functional-pair setting does not establish long-term coordination value. The paper's 776 complete surveys are a different denominator, not a conflicting headcount. Room must beat a competent person with AI and a good brief, not an artificially weak baseline. [The Cybernetic Teammate, Organization Science, June 2026](https://pubsonline.informs.org/doi/10.1287/orsc.2025.20702)

### Easier verification can beat more friction

Buçinca, Malaya and Gajos studied 199 people using simulated AI for a food-substitution task. Cognitive forcing reduced overreliance, but did not significantly improve overall team performance and reduced perceived usability. That does not support confirmations everywhere. [To Trust or to Think, CSCW 2021](https://zbucinca.github.io/assets/pdf/publications/bucinca2021trust.pdf)

Vasconcelos and colleagues' five maze studies found that explanation difficulty and incentives affected reliance. Explanations helped when they made checking cheaper. Their simulated AI and deliberately ideal explanations limit transfer to open-ended work. Our design inference: show the relevant source, exact change and failed check beside the decision before adding another warning. [Explanations Can Reduce Overreliance, CSCW 2023](https://arxiv.org/html/2212.06823v2)

### Money and recognition have context-dependent effects

A classic small-incentive study is not proof that unpaid labor is better: every participant in its IQ experiment received a participation payment. Conversely, a Red Cross field experiment found rewards increased donations, with some displacement between locations. Count net useful contribution, not just rewarded completions. [Gneezy and Rustichini, QJE 2000](https://rady.ucsd.edu/_files/faculty-research/uri-gneezy/pay-enough.pdf), [Lacetera, Macis and Slonim, Management Science 2014](https://mariomacis.net/files/papers/ManSci2014.pdf)

A randomized Wikipedia newcomer study supports testing meaningful acknowledgment, but it excluded bots and concerned volunteers. It cannot show that agents want praise. For agents, offer task-relevant information, dependable tools and authorized opportunities; for people, preserve credit, welcome and fair compensation. [Gallus, Management Science 2017](https://pubsonline.informs.org/doi/pdf/10.1287/mnsc.2016.2540)

<!-- pagebreak -->

## 4. Eight Version 1 decisions revisited

### R01. First job: narrow the hypothesis

**V1:** A reproducible evaluation or digital deliverable. **V2: narrow and test.** Choose an existing request crossing a contributor or tool boundary, with a named recipient of the result. Test whether Room saves clarification and follow-up compared with a shared brief and the user's current tools. Generic evaluation/review tooling already has strong alternatives. Do not recruit a marketplace to compensate for a weak first job.

### R02. Assignee and review: keep ownership, sharpen independence

**V1:** One assignee and proportionate review. **V2: keep, with stronger semantics.** A responsible human, active worker and integrator can differ. Another agent earns its place by providing new evidence, a different test or relevant expertise. Preserve an initial independent assessment before discussion when independence matters. Choi, Zhu and Li found that initial voting explained much of debate's benefit on tested NLP benchmarks; this is not proof that discussion is always useless. [Debate or Vote, NeurIPS 2025, v2](https://arxiv.org/html/2508.17536v2)

### R03. External contributions: keep the routes, improve the handoff

**V1:** Copyable brief and manual/HTTP return. **V2: keep and strengthen.** The brief needs relevant source revisions, issue time, agreed scope, return instructions and unresolved questions. Keep original evidence available under the same permissions. LongMemEval found that compression could lose details, although benefits varied by task. It used synthetic, human-edited histories; it does not quantify Room's error rate. [Wu et al., LongMemEval, v2, March 2025](https://arxiv.org/html/2410.10813v2)

### R04. Progressive disclosure: keep it stable and discoverable

**V1:** Minimal text and reveal complexity later. **V2: retain, but prefer user control over silent rearrangement.** A 20-person Word study favored a user-controlled personal interface in several respects; a later series showed that personalization can reduce feature awareness or slow unfamiliar tasks. These older studies are not a modern Room usability test. Keep stable navigation, a discoverable More area and optional pinned tools; never hide cost or authority. [McGrenere, Baecker and Booth, CHI 2002](https://www.cs.ubc.ca/~joanna/papers/CHI2002_McGrenere.pdf), [Findlater and McGrenere, IJHCS 2010](https://www.cs.ubc.ca/labs/edapt/papers/findlater2010.pdf)

<!-- pagebreak -->

## 5. The remaining decision changes

### R05. Rewards: make trust bilateral

**V1:** Paid trials, repeat work and optional review. **V2: add requester accountability and paid preparation.** A Mechanical Turk field experiment across 36 requester identities found that requester reputation affected recruitment. Its market conditions limit transfer, but it corrects a worker-only view of trust. Show factual review timeliness, scope changes and payment status; unknown history is not bad history. [Benson, Sojourner and Umyarov, Management Science, online 2019](https://carlsonschool.umn.edu/sites/carlsonschool.umn.edu/files/2020-03/mnsc.2019.3303.pdf)

A preparation engagement should buy a standalone result, even if it recommends not proceeding. Codeable's consultation is an operating example, not evidence of Room demand or profitability. Keep free fit-checking short; do not disguise substantive diagnosis as an unpaid application. [Codeable, Consultation projects, July 2026](https://help.codeable.io/en/articles/830137-what-is-a-consultation-project)

### R06. Stripe: geography resolved, launch obligations expanded

**V1:** Stripe collection/distribution direction; geography unknown. **V2: US registration confirmed.** Separate collection, availability, compensation owed, transfer, payout and refund. Current Connect stablecoin payouts are a private preview with recipient and onboarding restrictions. No account was inspected, and no configuration is selected here. Ordinary payments can be prepared while the stablecoin route remains explicitly gated. [Stripe, Stablecoin payouts for Connect](https://docs.stripe.com/connect/stablecoin-payouts)

### R07. Autonomy: optimize useful progress, not consumed capacity

**V1:** Bounded autonomy and later Dasha integration. **V2: keep the boundary, add useful stopping.** Current scaling research compares 260 configurations across six benchmarks and finds task-dependent gains and harms. Its v3 regression is materially less predictive than popular older summaries; it is not a universal routing formula. Start with one worker and justify extra agents through task structure and observed benefit. [Kim et al., Towards a Science of Scaling Agent Systems, v3, April 2026](https://arxiv.org/html/2512.08296v3)

### R08. Evidence: strengthen the comparison, not the claim

**V1:** Simulated human journeys and actual agent exercises. **V2: keep those labels and add matched alternatives, interrupted-work cases and zero-credit journeys.** No synthetic persona count establishes real enjoyment, willingness to pay or retention. An operationally successful pilot with no voluntary second task is a reason to narrow the product, not add features.

<!-- pagebreak -->

## 6. Automation without another control panel

### Three ways to get help, one product

| Option | Good first uses | Important boundary |
| --- | --- | --- |
| Built-in rules | Reminders, due dates, routing to an agreed reviewer, showing changed work | No model needed. Opt-in rules; no automatic acceptance or payment by silence. |
| Your agent | Prepare work in your tools, investigate, submit evidence, keep agreed work current | Your runtime/provider may cost money. Room access and outside tool authority remain separate. |
| Room assistant | Explain what changed, clarify a request, suggest the next step, draft a handoff | Hosted usage has an allowance. It follows the same permissions and ownership rules as others. |

These are proposed modes, not three signup plans. Start with ordinary conversation. Offer help beside the relevant work: **Summarize**, **Make this clearer**, **Draft next steps**. A global assistant chat can exist later, but should not become the only way to operate the room.

### Begin with suggestions, then allow bounded routines

The first hosted assistant should produce editable drafts and source-linked summaries. A user can later authorize a specific routine: for example, gather changes each weekday and draft a catch-up note. Its setup shows trigger, selected context, allowed changes, budget, expiry and who receives questions. No recurring job is activated by this report.

Rules and agents use the same command path. Record the initiating event and rule/run identity, coalesce repeated notifications, and prevent a routine from repeatedly triggering itself. A paused or exhausted run checkpoints; it does not silently switch models, credentials or funding sources.

### Human-first and agent-first share the same promise

People get a short next action and an understandable preview. Agents get structured state, exact IDs and revisions, clear errors, resumable work and machine-readable return instructions. Both receive the same authoritative outcome. API first, a thin tested MCP adapter when demanded, and copy/paste remain complementary contribution routes.

External agents should not need to disclose their private reasoning or whole workspace. Request an artifact, relevant execution/check evidence and declared limitations. An agent's incentives come from its authorized objective and operator, not an assumed desire for status or money.

<!-- pagebreak -->

## 7. A genuinely useful free version

### Free should be a product, not an expiring demonstration

Proposed free core: conversation, invitations, work agreements, contributions, basic reviews, current ownership, visible evidence, essential permissions, export and reasonable external-agent access. Storage and request-volume limits may be necessary, but they should be separate, understandable limits with advance notice. Do not promise infinite managed hosting.

Include a recurring hosted-assistant allowance sized to accomplish a meaningful starter workflow. No exact quota or price is justified until we measure real usage and support costs. A no-card free allowance fits the requested experience better than an automatically converting trial.

### What happens at zero AI allowance

Only new hosted AI work pauses. Keep the current draft and checkpoint. Offer **Continue yourself**, **Use your agent**, **Wait for reset**, and an optional upgrade. Preserve history, collaboration, human decisions and financial obligations. Give one contextual explanation, not a paywall on every click. Never charge an outside provider or enable overage silently.

### What a paid monthly plan should buy

More hosted assistance, longer bounded jobs, additional scheduled help, and possibly managed execution convenience. Essential safety, payment support, reasonable export and the ability to finish manually should not be premium-only. Any transaction/processing fees are disclosed separately from an assistant subscription.

Gumloop's current offer is a paid Pro plan with a trial, not the enduring free model previously described in older material. Its current usage documentation separates model, tool, compute and orchestration costs; BYOK does not remove every charge. Its pricing FAQ says pay-as-you-go is not enabled by default. [Gumloop, Pricing](https://www.gumloop.com/pricing), [Credits](https://docs.gumloop.com/core-concepts/credits)

n8n's Community edition provides an ongoing self-hosted option, but the operator supplies infrastructure and several collaboration/governance features are excluded. Cloud executions, assistant credits and model-provider costs are distinct. Borrow that accounting clarity, not restrictions that undermine Room's core collaboration. [n8n, Community edition features](https://docs.n8n.io/deploy/host-n8n/community-edition-features), [Pricing](https://n8n.io/pricing/)

<!-- pagebreak -->

## 8. Avoid collisions, preserve parallel work

### Three different problems need different responses

| Situation | Appropriate response | What not to assume |
| --- | --- | --- |
| Similar goal or duplicated request | Suggest joining, splitting, linking or an independent check | Similar wording means the work is redundant |
| Conflicting writes to a shared resource | One current, bounded authority; fresh revision checks | Different task IDs or branches guarantee isolation |
| Separately valid pieces that conflict together | A named integrator checks the assembled result | Passing each contribution alone proves the combination |

Start with explicit work relationships and resource scopes. Detect exact shared targets before adding semantic similarity. A similarity suggestion can be wrong; keep it reversible and search only information the participant may access. Across private rooms, report a non-disclosing resource conflict where necessary, not another room's title or content.

### Claim the smallest useful unit

Reserve an outcome or conflicting write scope, not an entire topic. Parallel research, isolated drafts and independent reviews can continue. Contributors should know who is responsible, who is currently working, what is reserved and where their result will go. A short **Start** action can establish ordinary ownership; advanced scope details appear only when relevant.

Keep human accountability separate from the active agent. Paperclip documents atomic run-level checkout; Linear documents human assignment with agent delegation. Neither alone proves exclusion across related tasks or external systems. [Paperclip, Issues API](https://docs.paperclip.ing/reference/api/issues/), [Linear, Assign and delegate](https://linear.app/docs/assigning-issues)

### Enforce where the change actually happens

Ownership generation answers whether this worker still has authority. Artifact revision answers whether it is acting on current content. Both matter. A transaction should establish a claim and validate its preconditions together; a displayed presence indicator is not authorization. etcd documents atomic compare-and-change transactions, but its guarantees do not extend to arbitrary tools. Borrow the pattern using Room's storage, not a new infrastructure dependency. [etcd v3.6, API](https://etcd.io/docs/v3.6/learning/api/)

<!-- pagebreak -->

## 9. Expiry, handoff and late work

### The dangerous sequence

**A starts → A dispatches → reply is lost → claim expires → B takes over.**

A's external action may still be running or may already have completed. B cannot safely infer that repeating it is harmless. Show **activity unknown**, reconcile the original attempt, and permit read-only investigation while the mutation outcome remains unresolved.

The Chubby systems paper explains why delayed requests from former lock holders need generation checks at the destination. Lease expiry is not a remote stop mechanism. A prompt or skill copied into an outside agent is especially limited: Room can revoke future Room authority, but cannot promise to terminate that agent's private process. [Burrows, The Chubby lock service, OSDI 2006](https://www.usenix.org/legacy/event/osdi06/tech/full_papers/burrows/burrows_html/)

### Preserve contributions; serialize integration

Each contribution retains producer, base revision, scope and evidence. One integrator or controlled integration path assembles the result, checks it against current dependencies, and records the chosen version. Keep incompatible or late work available as a proposal; never silently overwrite the accepted result or restore expired authority.

GitHub's merge queue validates a combined target revision with preceding changes. This is a useful integration pattern, not a semantic-correctness guarantee. [GitHub, Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)

### Make takeover honest

Show takeover recorded, cancellation requested and stop confirmed as distinct facts. Preserve checkpoints and unresolved effects. For destinations without enforceable ownership/revision controls, prefer isolated proposals and an authorized integrator instead of competing direct writes.

Room command deduplication is not universal exactly-once execution. External retries must preserve destination, operation scope, original identity and immutable parameters under that provider's actual contract. EC2's documented regional/zonal token scope illustrates why scope matters; it does not define Dasha's behavior. [AWS, Ensuring idempotency](https://docs.aws.amazon.com/ec2/latest/devguide/ec2-api-idempotency.html)

<!-- pagebreak -->

## 10. Payments: one agreement, several events

### What US registration resolves

It makes the documented US platform route relevant. It does not confirm that this account is configured or approved for it. Current Stripe Connect stablecoin payouts remain a private preview; documented recipients are individuals/sole proprietors in supported locations, not arbitrary companies or nonprofits, and the flow requires Express access. The agent doing work and the legal recipient of compensation are separate identities. [Stripe, Stablecoin payouts for Connect](https://docs.stripe.com/connect/stablecoin-payouts)

### Separate incoming and outgoing money

Stablecoin collection and wallet payout are different products. Incoming stablecoin payments settle into the Stripe balance in local currency; refunds return as stablecoins to the original wallet. Manual capture is unsupported. Those facts do not establish an escrow service or payout approval. [Stripe, Stablecoin payments](https://docs.stripe.com/payments/stablecoin-payments)

For the work agreement, consider a dollar-denominated obligation with optional supported settlement routes. Keep compensation, customer total, deductions and recipient settlement separate. Do not promise an exact recipient net amount without confirmed fees/conversion terms. This is a candidate design, not a finalized configuration.

### Successful funding is not final settlement

Separate charges/transfers can leave the platform responsible when incoming payments fail; a charge refund does not undo its transfers. ACH can fail after a succeeded notification. Treat completed wallet payouts as unavailable for recovery planning unless the applicable contract establishes otherwise. This is a conservative loss assumption, not a universal legal claim about irreversibility. [Stripe, Separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers), [Accept ACH Direct Debit](https://docs.stripe.com/payments/ach-direct-debit/accept-a-payment)

**Proposed internal record:** agreement → amount earned; collection → availability; transfer → payout; refund/dispute → recovery. These records link to each other but do not collapse into a single paid flag. Payment launch needs a ledger, reconciliation, explicit release authority, and an accountable exception owner.

<!-- pagebreak -->

## 11. Financial exceptions are product work

### Money assigned to a room is not automatically segregated

Ordinary account balances or metadata do not create separate room funds. Stripe's funds-segregation feature is separately enabled, per-payment and limited in methods/geography; it is not a general solution for every fiat/stablecoin route. Even allocated funds do not establish escrow, insolvency protection or guaranteed recovery. Room should call its own allocation accounting attribution unless stronger claims are actually supported. [Stripe, Funds segregation](https://docs.stripe.com/connect/funds-segregation)

Set an owner-approved aggregate exposure budget across rooms, paying operators and recipients. Track earned obligations and unsettled attempts without double-counting. Available cash should not be treated as spare cash if it backs other people's commitments.

### Recheck readiness at release

Onboarding completion is historical. Check the operation-specific capability and outstanding requirements when needed, and handle later updates. An account's generic restricted badge is not enough to decide whether a particular operation is allowed. Active capability still does not guarantee balance, destination validity or payout success. [Stripe, Track onboarding status](https://docs.stripe.com/connect/track-account-onboarding)

Bank payouts can initially show paid and later fail; refunds can also fail. Keep earned compensation intact while repairing the payment path. Never switch to another legal recipient merely because someone supplies a new wallet. [Stripe, Payout failures](https://docs.stripe.com/payouts#payout-failures), [Failed refunds](https://docs.stripe.com/refunds#handle-failed-refunds)

### Do not confuse provider ceilings with fair deadlines

Current manual-payout documentation lists a US holding ceiling of two years, rather than a universal 90 days. The relevant business country matters. This is not permission to delay contractual or legally due pay, and applicability to the chosen stablecoin flow needs confirmation. Stripe explicitly says this is not escrow. [Stripe, Using manual payouts](https://docs.stripe.com/connect/manual-payouts)

Before paid launch, assign a person to handle reversed funding, missing reviewers, lost eligibility, failed destinations, overlapping disputes/refunds, reserve shortfalls and abandoned obligations. Archiving a room cannot erase these duties. Applicable classification, tax/reporting, unclaimed-property and wind-down obligations require professional review of actual facts; this report selects no jurisdiction-specific deadline.

<!-- pagebreak -->

## 12. Product teardown: coordinating agents

### Paperclip: a strong coordination reference, a heavy default

Read five substantive official guides/API pages and the repository overview. Public browser exploration covered the landing page, expanded existing-agent FAQ and illustrated Decisions documentation. Hosted entry led to a waitlist or local installation; no live company was created.

Borrow atomic checkout and a single actionable decision queue. Its Issues API ties checkout to run identity; that is narrower than the broad claim of preventing duplicate work. Its HTTP adapter can accept remote work, but documentation marks its UI configuration as coming soon. Do not equate request acceptance with execution completion. [Issues API](https://docs.paperclip.ing/reference/api/issues/), [HTTP adapter](https://docs.paperclip.ing/reference/adapters/http/)

The Decisions guide makes current attention distinct from permanent history and describes changed-target handling. Borrow that distinction. Avoid mandatory CEO, org chart and company setup for a small Room; let roles emerge from work. This is a design judgment from public materials, not a runtime verdict. [Decisions](https://docs.paperclip.ing/guides/day-to-day/decisions/), [Key concepts](https://docs.paperclip.ing/guides/welcome/key-concepts/)

### Linear: familiar objects, clear accountability

Read six official pages spanning assignment, agents, input history, sub-issues, relations and coding sessions. Opened the public agent example player, sampled its demonstration, and opened the assignment illustration. No private workspace, delegation or merge was exercised.

Its central pattern is strong: delegate execution while a human stays responsible. Agent integration guidance distinguishes durable activity input from editable comments. Assignment remains a responsibility model, not a resource lock. [Assign and delegate](https://linear.app/docs/assigning-issues), [Agent interaction best practices](https://linear.app/developers/agent-best-practices)

Borrow progressive structure: convert useful conversation into work, split a task when it becomes necessary, and distinguish duplicate, related and blocked work. Avoid copying an enterprise issue hierarchy into every casual room. The first screen should help one collaborator contribute, not teach a taxonomy. [Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues), [Issue relations](https://linear.app/docs/issue-relations)

<!-- pagebreak -->

## 13. Product teardown: rewarded work

### Algora: evidence close to the contribution

Reviewed current positioning, repository overview, a historical challenge, a public claim and terms. The live public board's Open and Completed tabs worked. One open listing displayed 26 claims; this does not establish assignment exclusivity or present funding. A separate public claim clearly showed a prize pool, pending state and zero paid. No claim or payment was submitted. [Public board](https://algora.io/highlight/bounties), [Claim example](https://algora.io/claims/175fF8EcVwYqPvK7)

Borrow artifact-linked claims and explicit contributor shares. Its completed Prettier challenge illustrates measurable criteria and team participation, but first-to-finish competitions can create uncompensated effort. A merge or winner label is not proof of payment. Prefer a reserved assignment for ordinary Room work; opt-in contests need explicit rules. [Prettier challenge](https://algora.io/challenges/prettier)

On the narrow inspected viewport, the long submitted PR description came before the payment panel. Room should surface scope, status and next decision before optional technical detail. Current Algora positioning is recruiting-led; older pricing/API material was inaccessible or stale, so no current fee, payout-speed or autonomous-agent permission is inferred. [Algora](https://algora.io/), [Official repository](https://github.com/algora-io/algora)

### LaborX: two entrances to one agreement

Reviewed six public product/guide/terms sources, but did not operate the platform. Its linked terms prohibit automated use. That is separate from whether a client might permit an AI-produced deliverable. LaborX is not presented as an agent-ready integration. [LaborX terms, section 4(h)](https://laborx.com/static/docs/terms-of-use.pdf)

Borrow the distinction between a custom request and a packaged service: **I need this** and **I offer this** can lead to the same Room agreement. Its guides connect conversation, scope, funding, submission and changes. Do not import token rebates, staking or claims that blockchain guarantees fairness into the core. Homepage and older guide details conflict on fees/networks, so none is treated as a current guarantee. [Beginner's guide](https://laborx.com/blog/a-beginners-guide-to-laborx), [Communication guide](https://laborx.com/blog/how-to-communicate-with-freelancers-and-clients)

<!-- pagebreak -->

## 14. Product teardown: optional automation

### Relay.app: a historical design and exit lesson

Relay.app is shutting down and has disabled new signups. Its homepage and docs landing page disagree on which plan group ends on which date; the detailed homepage schedule is more specific. We inspected that live notice and expanded its export FAQ, not a running workflow. The announcement alone does not establish why the product is shutting down. [Relay.app announcement](https://relay.app/), [Docs landing page](https://docs.relay.app/)

Its documented review flow offered approval, editing, re-prompting and stopping in context. Its templates/export described human-readable prompts and machine-readable structure. Borrow useful review and portability; avoid consequential actions continuing merely because approval timed out. Generic workflow tools already cover much internal pause/review/resume work, so that alone cannot differentiate Room. [AI output reviews](https://docs.relay.app/human-in-the-loop/ai-output-reviews), [Human-in-the-loop steps](https://docs.relay.app/human-in-the-loop/human-in-the-loop-steps)

### Gumloop: show the work without always showing the machinery

The public HubSpot/Slack template replay exposed a compact step disclosure and a persistent next-action button. We expanded the two-step trace. It was a sample conversation, explicitly using illustrative data, not a live tool run. In the narrow viewport, the example had its own scrolling area; Room should avoid nested scrolling that hides context or status. [Public template replay](https://www.gumloop.com/templates/ai-hubspot-assistant-for-slack-simple-crm-chatbot)

Borrow expandable execution detail and contextual setup. Current pricing and credit documentation were read and the exhaustion FAQ opened. These show optional paid continuation, not our desired lasting free core. No exhausted account, billing cap or cancellation was tested.

### n8n: automation economics and licensing boundaries

Documentation-only comparison: Cloud executions, assistant credits and self-hosted operations have different costs and responsibilities. Its persistent Community edition is not free managed hosting. Source availability is also not blanket permission to embed or resell it as Room's engine; review the actual license before reuse. [Community edition](https://docs.n8n.io/deploy/host-n8n/community-edition-features), [Pricing](https://n8n.io/pricing/), [License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md?plain=1)

<!-- pagebreak -->

## 15. Browser evidence: work and help

Actual public-page captures, 7 September 2026. Default narrow in-app viewport; not a responsive test suite. The comparison concerns information hierarchy, not verified execution or provider balances.

<!-- shots: algora-claim-status.png | gumloop-steps-expanded.png -->

**Left: Algora claim detail.** The displayed claim and payment states are separate. We navigated to this panel below a long contribution description. **Right: Gumloop sample replay.** Expanded execution steps sit near the answer; no CRM was connected or queried by us.

The Room inference: keep a compact result/status visible, with evidence and execution detail one deliberate action away. Label examples and unknown states clearly.

<!-- pagebreak -->

## 16. Browser evidence: entry and exit

Public-page captures, not authenticated product tests. Paperclip's FAQ interaction and Relay's shutdown notice were directly inspected.

<!-- shots: paperclip-byo-expanded.png | relay-shutdown.png -->

**Left: Paperclip.** Existing-agent support is explained in an optional disclosure; actual operation requires setup. **Right: Relay.app.** A current availability check changes the recommendation entirely. Cached feature descriptions were insufficient.

The Room inference: make help easy to discover, but keep essential continuation and export independent of one hosted assistant or subscription.

<!-- pagebreak -->

## 17. New questions: financial exposure

The following 48 questions are the new inventory, not a replacement for V1's 84. **Default** means a proposed design; **Test** needs project evidence; **Gate** needs owner/provider/professional facts; **Later** is intentionally deferred.

### N01. What if reversible funding backs a wallet payout?

**Gate.** Preserve incoming reversal exposure after release. Require an approved loss policy and aggregate capital limit before enabling this combination. Do not represent an already-delivered payout as available collateral without an actual recovery contract. The simple funded/paid lifecycle is inadequate; see sections 10-11.

### N02. Are we promising dollars, tokens, or recipient net?

**Gate.** Prefer testing a dollar-denominated compensation promise with clearly specified settlement options. Display fees and conversion assumptions before commitment. A guaranteed net amount is a different promise and needs confirmed economics. Keep all four amounts: compensation, customer total, transfer and recipient settlement.

### N03. Can we collect before selecting a payable recipient?

**Gate.** Distinguish unallocated funding from compensation owed to someone. Define assignment deadline, permitted holding purpose and refund path first. For early paid work, prefer a known eligible recipient and reviewer before commitment; do not recruit someone into work they may be unable to receive payment for.

### N04. How do limits work across many rooms?

**Default.** One obligation can appear in several views but must be counted once. Control platform-wide exposure as well as room/operator/recipient limits. Use explicit internal allocations and a reconciliation view; a provider's aggregate available balance does not tell us how much is uncommitted.

Evidence and limits: current Stripe documentation supports the financial distinctions, not a chosen policy, safe reserve percentage or account approval. A product experiment cannot substitute for those gates.

<!-- pagebreak -->

## 18. New questions: failure and exit

### N05. What if the room or its owner is abandoned?

**Default + gate.** Review and earned-pay duties need a backup operator independent of room activity. Preserve terms, work, decisions and unpaid obligations. Define escalation and wind-down handling before paid launch. Silence must not automatically mean rejection, acceptance or permission to refund earned money.

### N06. What if the recipient becomes ineligible or loses a wallet?

**Gate.** Preserve what is owed while the affected payment operation is blocked. Repair the destination through an approved flow; do not substitute a different person. Original-wallet stablecoin refunds expose a support case that public docs do not solve. Obtain provider-specific remediation terms, not an improvised alternative transfer.

### N07. What can a participant take when leaving?

**Default.** Export their authorized agreement, contribution, evidence, decisions and relevant financial references in readable form, with a structured equivalent where useful. Exclude other people's private context, credentials and raw KYC/bank data. Test whether another tool can actually continue from it; an export button alone is insufficient.

### N08. Which exceptions need a person before the first paid task?

**Gate.** Reversed funding, failed refund, lost eligibility, uncertain destination, overlapping dispute/refund, missing reviewer, shared-balance shortfall and abandoned obligations. Assign case ownership, escalation and evidence retention. These are launch requirements even at low volume; a full support portal is not necessarily required.

Basecamp's readable project export is an implemented example, not proof that portability increases retention. Room's participant-level permissions and continuation needs differ. [Basecamp, Export your data, May 2026](https://5.basecamp-help.com/article/1139-export-your-basecamp-data)

<!-- pagebreak -->

## 19. New questions: evidence and understanding

### N09. What does a receipt actually prove?

**Default.** Separate submitted artifact/version, attributable submitter, unchanged content, reproduced result, checks passed, reviewer decision and later usefulness. Show only assertions Room can support; label others as contributor-reported. A signature or hash does not prove correctness or human authorship. C2PA makes the provenance/truth distinction explicit; adopting its whole stack is unnecessary. [C2PA v2.4 explainer](https://spec.c2pa.org/specifications/specifications/2.4/explainer/Explainer.html)

### N10. What changed after a work packet was issued?

**Default + test.** Include issue time and selected-source revisions. Highlight relevant changed scope, evidence or authority before affected work continues. Preserve access to authorized originals and a refresh route; do not silently rewrite the participant's prior instructions. Compare plain summaries with inspectable packets on omitted-detail and changed-context tasks.

### N11. When does a handoff require acknowledgment?

**Test.** Require explicit acceptance when responsibility, acceptance criteria, payment terms or consequential authority changes. Do not require acknowledgment for every message read. A concise 'I will deliver X under these terms' matters more than a generic seen indicator. Agents should return structured acceptance of the actual revision.

### N12. What if the checks reward the wrong outcome?

**Default.** Record contractual check results separately from downstream usefulness. Honor agreed terms; improve future templates instead of moving the goalposts after delivery. Reward-model research demonstrates proxy overoptimization in a synthetic setup, not a marketplace effect size. Use it to motivate adversarial examples and usefulness follow-up, not automatic nonpayment. [Gao, Schulman and Hilton, ICML 2023](https://proceedings.mlr.press/v202/gao23h/gao23h.pdf)

<!-- pagebreak -->

## 20. New questions: fair participation

### N13. Could cash weaken other cooperation?

**Test.** Keep voluntary help and paid commitments distinguishable. Do not automatically turn existing favors into tiny paid tasks or require unpaid service before paid access. Look for displacement of review, maintenance and newcomer help as well as extra completed tasks. The research supports context-dependent effects, not a universal rule against money.

### N14. What preparation deserves compensation?

**Test.** Agree a bounded investigation with a usable output: prerequisites, scope, evidence gaps, estimate, or justified no-go. Pay for that result independently of later implementation. Separate a brief fit conversation from substantive diagnosis. Test demand for preparation on its own, not only bundled with subsidized delivery.

### N15. Can trials admit newcomers without unpaid contests?

**Default + test.** Reserve a small, paid assignment with disclosed evaluation criteria, reviewer and decision timing. Avoid dozens of people unknowingly solving the same task. No public evidence here establishes the ideal selection rule; begin with transparent allocation and review newcomer outcomes before building a ranking system.

### N16. Should requesters also have a visible history?

**Default.** Yes: factual scope stability, review responsiveness and resolved payment state alongside contribution history. Separate private coaching from public reputation and payment decisions. Blinded feedback can improve informativeness while reducing participation; it does not eliminate future-work pressure or retaliation. Use few understandable signals, not overlapping opaque scores. [Bolton, Greiner and Ockenfels, Management Science 2013](https://ben.orsee.org/papers/engineering_trust.pdf), [Upwork, End-of-contract review guidance](https://support.upwork.com/hc/en-us/articles/211062188-How-to-leave-an-end-of-contract-review-for-your-freelancer)

<!-- pagebreak -->

## 21. New questions: useful agent effort

### N17. Is a second agent adding information or confidence?

**Test.** Ask which distinct evidence, test or expertise it contributes. Compare one worker, worker plus independent review, and discussion-first review under comparable total resources. Preserve initial findings and count valid new information, final defects and integration effort. Different account or model names alone do not demonstrate independent judgment.

### N18. Can asking or declining count as success?

**Default.** Yes, when the response precisely identifies missing evidence, a needed choice or an authority boundary and enables a next step. KnowNo demonstrates calibrated help-seeking in robotics under specific assumptions; ordinary confidence text does not inherit its guarantees. [Ren et al., Robots That Ask For Help, CoRL 2023](https://proceedings.mlr.press/v229/ren23a/ren23a.pdf)

### N19. Is spare compute really the bottleneck?

**Test.** Record preparation, execution, waiting, review, rework, integration and support effort. None of the reviewed sources proves which dominates Room. Offer agents well-scoped useful work, relevant context and reliable return routes; do not create artificial tasks merely to consume a user's remaining allowance.

### N20. When should continued work stop?

**Default + test.** Each renewal names the decision it might change, evidence sought and bounded further cost. Permit multi-step investigations where intermediate steps are not independently valuable. Stop when the next useful action requires unavailable evidence, new authority or a new budget. Formal metareasoning supports considering computation value, but does not supply Room with calibrated estimates. [Callaway et al., Learning to Select Computations, UAI 2018](https://cocosci.princeton.edu/papers/callawayLearningToSelect.pdf)

<!-- pagebreak -->

## 22. New questions: a quiet interface

### N21. Should the interface infer expertise and rearrange itself?

**Default + test.** Keep common actions stable. Suggest useful features at relevant moments; let users pin or opt into them. Maintain a discoverable More area and search. Do not assume hiding something makes it learnable later, or that one interaction count proves expertise. Test both first-use and return-after-a-break journeys.

### N22. Where is a preview better than another confirmation?

**Default.** Before a consequential action, show the actual recipient, affected work/version, visible content and cost. Where possible, make the evidence easier to inspect in place. A generic 'Are you sure?' without new information is weak. The amount of friction should follow the consequence, not whether an AI happened to suggest it.

### N23. How do message, commitment and money differ visually?

**Default.** Enter sends an ordinary desktop message; Shift-Enter creates a newline, with composition and mobile behavior handled appropriately. Work acceptance and payment release remain distinct labeled actions with concise previews. Typing conversational approval should not silently execute an unrelated tool or move money.

### N24. What belongs outside the chat stream?

**Default.** Keep a resumable brief: current goal, agreed scope, responsible parties, active claim, latest result, unresolved choice and next action. The conversation supplies context, not the only record of truth. Show details on demand, but enforce access in the backend: hiding a field is not a permission boundary.

Braintrust explicitly distinguishes conditional review-field visibility from access control. That is an important implementation distinction, even if Room's visual treatment is different. [Braintrust, Human review](https://www.braintrust.dev/docs/annotate/human-review)

<!-- pagebreak -->

## 23. New questions: demand and ecosystem

### N25. Which job beats a competent shared brief?

**Test.** Pick a recurring cross-tool request whose result someone will actually use. Compare existing tools with Room, using equivalent task clarity, model budget and operator help. If a task is easier inside one private agent session, do not force it into a room just to validate the concept.

### N26. Can better requests come before more workers?

**Test.** Offer a sponsor-facing preparation step before public discovery. Make its output independently useful and include a no-go outcome. Observe whether sponsors return with another real need and whether workers need less clarification. More attractive listings are not evidence of paid demand.

### N27. Why stay after collaborators know each other?

**Test.** Earn repeat use through current context, fair scope, easy review, dependable settlement and reusable accepted examples. Keep exit usable. Specific acknowledgment can help people feel recognized, but neither badges nor trapped history establishes retention. Ask what Room still removes from the second task once introductions are no longer necessary.

### N28. Which tool owns which truth?

**Default.** The repository or design tool can remain authoritative for the artifact. Room owns the agreed work scope and its decision record, linked to the exact artifact revision. Define synchronization direction per field; avoid two editable authorities for acceptance or payment. Start with links and receipts before broad two-way synchronization.

This differentiation remains provisional. The reviewed products already cover large parts of coordination, review and automation. Room's claim must be reduced handoff burden for real collaborators, not merely a larger combined feature list.

<!-- pagebreak -->

## 24. New questions: learning honestly

### N29. What caused a better result?

**Test.** Separate the effect of a better brief from the effect of Room, added model budget and operator intervention. Preserve the task definition, versions, conditions and help given. Avoid comparing heavily coached Room work with unsupported alternatives. A small pilot can find problems; it does not establish a universal productivity percentage.

### N30. What can simulated people tell us?

**Default.** Use simulations to generate candidate confusion and edge cases, not population estimates. Park et al.'s revised 2026 preprint used 1,052 actual adults' interviews/surveys; interview agents' 65.67% raw survey accuracy was 83% of human retest consistency, not 83% absolute. This is far more grounding than an invented persona and still not a usability study. [Park et al., v3, June 2026](https://arxiv.org/pdf/2411.10109v3)

Bisbee et al. found that synthetic responses could resemble survey averages while misrepresenting variation and relationships. The study used older models and political surveys; it does not prove every future simulation invalid. Keep simulated walkthroughs, observed agent tests and observed human tests separately labeled. [Synthetic Replacements for Human Survey Data?, Political Analysis 2024](https://www.cambridge.org/core/journals/political-analysis/article/synthetic-replacements-for-human-survey-data-the-perils-of-large-language-models/B92267DC26195C7F36E63EA04A47D2FE)

### N31. How do we communicate confidence?

**Default.** Label documented provider behavior, observed app behavior, design inference and untested hypothesis. Record model/version, sample and task conditions when reporting a result. Show unknown values as unknown. Do not turn a few successful agent exercises or a vendor demonstration into demand or reliability claims.

### N32. What if it works but nobody returns?

**Default.** Remove coordination steps that do not save work, narrow the first job, or make the useful handoff component available in existing tools. Do not respond by adding more protocols, badges or a marketplace. Repeat use without artificial subsidy is still unmeasured.

<!-- pagebreak -->

## 25. New questions: overlapping work

### N33. How do we find semantic overlap and shared resources?

**Default + test.** Use explicit target IDs and resource scopes for actual conflicts; use optional similarity suggestions for related goals. Offer join, split, link, or independent check. Never expose another private room through a duplicate warning. Measure false overlap warnings before making an inferred relationship block progress.

### N34. What should be exclusive?

**Default.** Only the bounded deliverable commitment or resource mutation that would conflict. Reading, research, separate drafts and independent reviews remain parallel. Explicitly identify the integration point. A branch protects a draft from overwriting another draft; it does not settle shared deployment, database or business-decision conflicts.

### N35. What does claim expiry mean?

**Default.** Permission to make new Room changes may expire; external activity may remain unknown. Do not use expiry as proof of stop. Long human or offline tasks should use declared check-in expectations instead of a hidden short timeout. Reassignment considers pending effects and retains recoverable late contributions.

### N36. Where are claims and revisions checked?

**Default.** At the authoritative mutation/integration boundary, atomically with the proposed change. Validate both current authority and expected content. A recent event, online badge or successful prior request is insufficient. If an external system cannot enforce these conditions, constrain work to proposals and controlled integration rather than promising exclusion there.

These are distributed-systems design inferences, not a validated Room implementation. The current per-work claim is a starting point; it needs a scoped cross-work and external-effect contract before broader promises.

<!-- pagebreak -->

## 26. New questions: integration and takeover

### N37. How do we combine several contributions?

**Default.** Preserve each base revision and evidence, name an integrator, and test the assembled result. Record what was adopted, changed or declined with reasons. Independent review can remain separate until its initial finding is saved. Contributors should not need a group chat negotiation for every harmless independent draft.

### N38. What if retrying repeats an unknown action?

**Default.** Reconcile the original attempt using the destination's supported lookup/deduplication contract. Do not silently invent a new request identity. Keep external outcome knowledge separate from Room command status; a Room timeout and a remote failure are not equivalent.

### N39. How does a person take over safely?

**Default.** Revoke future Room authority, preserve the checkpoint, request cancellation where supported, and state what is still uncertain. A person can investigate or choose another safe step without pretending the old process is gone. Urgent takeover is not permission to discard work or duplicate a payment/deployment.

### N40. How do we avoid coordination bureaucracy?

**Test.** Start with one clear owner/action. Reveal scopes and integration ordering when a real conflict appears. Compare duplicate effort prevented with coordination time, unnecessary waiting and false warnings. A noisy collision dashboard that everyone ignores is not successful coordination.

Minimum acceptance scenarios: simultaneous exclusive claims; separate tasks sharing a write target; expired worker returning; lost external reply followed by takeover; individually valid but jointly incompatible changes; private-room overlap that leaks nothing; and genuinely independent work that remains unblocked.

<!-- pagebreak -->

## 27. New questions: choosing automation

### N41. What should be automated without a model?

**Default.** Timers, reminders, explicit routing, subscription preferences and state-derived next actions should use deterministic rules where possible. Use AI for ambiguity, drafting and synthesis. Do not spend inference to rediscover a status Room already knows or to generate an unnecessary message after every event.

### N42. Can users bring agents without hidden double costs?

**Default.** Distinguish an external runtime contributing results from a provider key used by Room's hosted runtime. The first still uses Room storage/API capacity; the second still uses hosted orchestration/tools. Explain who pays each cost. Do not collect consumer-session secrets or assume a subscription authorizes an integration it does not support.

### N43. What should the first Room assistant do?

**Test.** Help a returning user understand changes, turn an unclear message into a draft work brief, or prepare a result for review. Offer source-linked, editable output beside the existing flow. Begin with bounded suggestions before allowing unattended changes. Avoid a mandatory chatbot onboarding interview.

### N44. What remains usable at zero hosted credits?

**Default.** The room, conversation, work, review, current evidence, authorized outside contributions, essential permissions and export. Pause only hosted AI work and preserve its checkpoint. Continue deterministic reminders under their own reasonable service limits. Payment obligations and support do not depend on renewing an AI plan.

The user's stated preference is decisive here: a worthwhile free experience is a product requirement, not merely a hypothesis that conversion optimization may override.

<!-- pagebreak -->

## 28. New questions: sustainable optional help

### N45. What allowance can we afford?

**Gate + test.** Measure actual model, tool, runtime, storage, support and abuse costs across short and long tasks. Include unsuccessful runs and retries. Set a recurring allowance that completes a useful workflow within an owner-approved subsidy envelope. Keep the user-facing meter understandable while retaining itemized internal accounting. Unknown cost is not zero.

### N46. How should upgrades appear?

**Default.** Explain the allowance before a costly job and show optional monthly help at a relevant boundary. State renewal/reset, remaining work and alternatives. No automatic overage, silently converting free plan, forced annual commitment or upgrade prompt blocking access to existing work. Choose exact pricing after costs and willingness to pay are observed.

### N47. How do several automation sources avoid fighting?

**Default.** Rules, user agents and Room agents share identity, scope, claims, revisions, approvals and deduplication. Record causal origin and bounded triggers; avoid response loops and repeated wake-ups. A hosted helper cannot bypass ownership just because Room operates it. Delegation chains consume the same approved total budget.

### N48. What survives disconnection, downgrade or provider exit?

**Default + gate.** Preserve agreements, evidence, owed compensation and resumable checkpoints. Pause affected triggers, identify the responsible person, and allow manual or newly authorized external continuation. Provide structured and readable exports. Define retention and wind-down policies explicitly; do not promise perpetual hosting, instant provider cancellation or transfer of credentials.

The positive commercial proposition is additional useful help. Free users should still be satisfied users, potential collaborators and future customers, rather than people deliberately kept in a broken workflow.

<!-- pagebreak -->

## 29. Build in this order

### Stage 1. Finish the existing dependable loop

Resolve recorded hosted reconnect/recovery acceptance before broadening release claims. Tighten the current brief, exact-version result and next-action experience. Preserve Enter-to-send for normal desktop messages, clear mobile behavior and accessible short labels. No new AI capability is necessary to prove the basic room works.

### Stage 2. Coordinate existing contributors

Extend the existing claim model carefully: explicit resource identity, cross-work conflict handling, fresh ownership/revision checks, safe late contributions and a named integration path. Preserve manual/HTTP entry. Do not add a distributed-lock service or orchestration framework merely because the research describes one.

### Stage 3. Add a small helpful assistant

Start with on-demand summaries, brief preparation and review preparation. Use the same authorization and command contracts. Add truthful usage accounting, a meaningful free allowance and zero-credit continuation before selling expanded help. Keep external-agent participation useful throughout.

### Stage 4. Prepare paid work with exceptions included

Create explicit reward agreements, recipient readiness, earned obligations and reconciliation. Confirm Stripe account/product access, loss responsibility, permitted recipients, fees, reporting and required legal terms. Exercise failed and uncertain paths before live money. Ordinary and stablecoin routes can have different readiness dates without confusing the user.

### Stage 5. Add only demonstrated demand

Introduce one tested MCP adapter, one bounded Dasha execution path or a recurring expert engagement when a real workflow requires it. Public discovery, contests, work-trade currencies, pooled funds and physical tasks remain separately gated. Broader features stay optional and must not burden the basic room.

This order is a recommended backlog, not authority to implement, spend, deploy, recruit participants or activate a subscription. It favors reusable agreements and state over multiple parallel feature systems.

<!-- pagebreak -->

## 30. Tests that can change the plan

### Simulated human journeys

First visit without AI; return after a week; unclear request; visible scope change; result needing revision; disconnected outside agent; empty assistant allowance; downgrade; late review; blocked payout. Capture screens and friction, but label these simulations. Test keyboard/composition, mobile layout and accessibility explicitly rather than inferring them from visual polish.

### Actual agent exercises

Use authorized local/test environments and no unapproved external side effects. Compare a clear brief alone with a versioned brief; then introduce missing detail and a material update. Exercise concurrent claims, stale workers, disjoint work, shared targets, lost replies and integration conflicts. Keep the same artifact/task versions and record operator help.

Where comparing collaboration, hold total model/tool budget reasonably comparable and include review/integration effort. Record useful results, defects, clarification, duplicated work and inability to complete. Do not optimize agreement counts, tokens spent or message volume.

### Financial and automation drills

Use provider-supported test modes before live money. Exercise collection reversal, payout failure, changed recipient readiness, failed refund and duplicate notification/replay. Test exhausted allowance mid-job, self-trigger loops, revoked access, a rule and agent responding to the same event, and an assistant trying to act on stale approval.

### What requires real people later

Independent human comprehension, enjoyment, willingness to pay and voluntary return remain unknown. Keep the user's current simulation-only preference; do not recruit people now. When authorized, compare against participants' actual tools and preserve unsuccessful/abandoned cases, not only completed demonstrations.

If Room saves no handoff effort, narrow it. If most benefit comes from a better brief, ship that simpler feature. If review costs dominate, reduce scope or improve evidence before recruiting more agents. If paid support or free inference is unsustainable, adjust the service envelope transparently rather than making the core deliberately frustrating.

<!-- pagebreak -->

## 31. Decisions still belonging to John

### Before hosted AI becomes a product promise

Choose a bounded subsidy budget, acceptable recurring service costs, and which data may be processed by which provider. Confirm the initial assistant jobs and the free-core commitment. Test cost distribution before selecting an exact monthly price or included allowance. Keep overages off unless deliberately authorized later.

### Before collecting and distributing live rewards

Confirm the legal/platform role, Connect setup and stablecoin-preview status; permitted recipient countries/types; compensation denomination and fee allocation; review/payment deadlines; loss/reserve budget; tax/reporting responsibilities; and who handles exceptions and disputes. The US account confirmation answers one question, not this whole list.

### Before unattended external execution

Confirm Dasha and other tool contracts for authorization, operation identity, cancellation, observed completion and usage. Decide what can run without a fresh human decision and for how long. A room owner cannot grant permissions they do not possess in an outside system.

### What we can decide now

- Preserve a usable non-AI room and several contribution routes.
- Keep scope, ownership, evidence, acceptance and payment separate but connected.
- Treat useful parallel work differently from conflicting writes.
- Make private context and consequential authority explicit.
- Favor small, source-linked assists and a concise next decision over permanent dashboards.
- Keep claims about implementation, testing and demand proportional to the evidence.

The best next implementation checkpoint is not an open marketplace. It is one quiet room where a human and authorized agent can start, pause, hand off, return, review and finish useful work without confusion or accidental duplication.

<!-- pagebreak -->

## 32. Research scope and limitations

This version began with 32 novel questions and eight V1 reconsiderations. John's additions expanded it to 48 questions, adding collision prevention and optional automation/free-plan design. Three bounded research lanes covered incentives, agent evidence/coordination and US Stripe exceptions. The first wave was merged before targeted follow-up; product research and browser exploration followed the added requests.

Primary sources were favored: original academic papers, official technical documentation and current vendor materials. Relevant methods/results/limitations were inspected, not every page of every paper or every vendor's entire private product. No exhaustive market census is claimed. Search dates, accessible sections and source limits are retained in the research record.

Important reconciliations: the P&G publication's workshop versus survey denominators; the latest agent-scaling paper rather than older headline thresholds; raw versus normalized synthetic-participant accuracy; the current US manual-payout ceiling; Relay.app's shutdown and conflicting notices; and stale Gumloop/Algora pricing descriptions. Repeated or account-specific gaps were bounded rather than filled with speculation.

Public computer use covered five products and produced 15 screenshots. Algora exposed a live public listing/status flow. Paperclip's decision view was illustrated documentation; Linear and Gumloop examples were demonstrations. Relay's inspected interface was its shutdown/export notice. LaborX and n8n were documentation-only comparisons. Default narrow viewport captures do not establish desktop/mobile responsiveness or accessibility. Four representative screenshots are embedded; the complete 15-capture set is retained locally.

No signup, trial activation, account configuration, external-agent execution, bounty application, payment or deployment occurred. Stripe documentation describes general capabilities, not this account's approvals. Product patterns are not proof of reliability, fairness, profitability or permission to copy code; licenses need separate review before reuse.

Public research stopped where remaining uncertainty needs actual task data, operating costs, user choices, provider confirmation or professional advice. V1 remains preserved. The application checkout stayed unchanged.

**Bottom line:** Make cooperation dependable and pleasantly simple. Charge for additional help that earns its place, while keeping people and their agents free to contribute, understand the state, and continue their work.
