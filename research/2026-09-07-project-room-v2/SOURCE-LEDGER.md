# Version 2 source ledger

Accessed 7 September 2026 unless otherwise stated. This supplements the claim-level links in the canonical report and EVIDENCE-AND-GAPS.md; it is not a second report. Publication dates are distinguished from access dates. Living documentation is undated where no publication date was established. No private account or licensed-only content was used. Relevant methods, results and limitations were inspected; this does not claim line-by-line reading of every paper.

## Academic evidence

| Authors / date | Source | Evidence used and limit |
| --- | --- | --- |
| Dell'Acqua et al.; Organization Science, 12 June 2026 | [The Cybernetic Teammate](https://pubsonline.informs.org/doi/10.1287/orsc.2025.20702) | 791 workshop participants, 776 complete post-task surveys. Generated ideas versus selection. One-day P&G setting; not Room demand. Root checked denominators and relevant results. |
| Buçinca, Malaya and Gajos; CSCW 2021 | [To Trust or to Think](https://zbucinca.github.io/assets/pdf/publications/bucinca2021trust.pdf) | 199 participants; cognitive forcing reduced overreliance, no significant overall team-performance gain; usability cost. Simulated AI food task. Root methods/results/limits. |
| Vasconcelos et al.; CSCW 2023, v2 | [Explanations Can Reduce Overreliance on AI Systems During Decision-Making](https://arxiv.org/html/2212.06823v2) | Five studies, aggregate N731; verification difficulty and incentives. Ideal maze explanations and simulated AI; not open-ended work. Root second-wave methods/limits. |
| McGrenere, Baecker and Booth; CHI 2002 | [An Evaluation of a Multiple Interface Design Solution for Bloated Software](https://www.cs.ubc.ca/~joanna/papers/CHI2002_McGrenere.pdf) | 20-person Word field study; adaptable interface preference, order/period limits. Root primary methods/results. |
| Findlater and McGrenere; IJHCS 2010 | [Beyond performance: Feature awareness in personalized interfaces](https://www.cs.ubc.ca/labs/edapt/papers/findlater2010.pdf) | Three studies; feature awareness and new-task costs. Context-specific, older interfaces. Root selected primary sections. |
| Benson, Sojourner and Umyarov; online 2019, Management Science 2020 | [The Value of Employer Reputation in the Absence of Contract Enforcement: A Randomized Experiment](https://carlsonschool.umn.edu/sites/carlsonschool.umn.edu/files/2020-03/mnsc.2019.3303.pdf) | 36 randomized requester identities; separate audit evidence not merged into a causal Room estimate. Root spot-check. |
| Bolton, Greiner and Ockenfels; Management Science 2013 | [Engineering Trust](https://ben.orsee.org/papers/engineering_trust.pdf) | 192 people, 60 rounds; feedback information versus participation. Detailed ratings, not all treatments, improved market efficiency significantly. Lane primary review. |
| Gneezy and Rustichini; QJE 2000 | [Pay Enough or Don't Pay at All](https://rady.ucsd.edu/_files/faculty-research/uri-gneezy/pay-enough.pdf) | IQ experiment included participation pay for all; zero marginal reward is not unpaid labor. Lane primary review. |
| Lacetera, Macis and Slonim; Management Science 2014 | [Rewarding Volunteers: A Field Experiment](https://mariomacis.net/files/papers/ManSci2014.pdf) | Red Cross incentive experiment; displacement matters. 98,278 contacted versus 79,680 eligible analytic set; not Room conversion forecast. Root spot-check. |
| Gallus; Management Science 2017 | [Fostering Public Good Contributions with Symbolic Awards](https://pubsonline.informs.org/doi/pdf/10.1287/mnsc.2016.2540) | 4,007 German Wikipedia newcomers; bots excluded. Human recognition, not agent preferences. Lane primary review. |
| Wu et al.; LongMemEval v2, March 2025 | [LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory](https://arxiv.org/html/2410.10813v2) | 500 curated questions, synthetic/human-edited histories. Lossy compression and task-category differences. Root spot-check. |
| Choi, Zhu and Li; NeurIPS 2025, v2 October 2025 | [Debate or Vote](https://arxiv.org/html/2508.17536v2) | Five-agent/seven-benchmark comparison; initial voting accounts for much observed gain. Does not prove all discussion wasteful; budgets not universally matched. Root spot-check. |
| Kim et al.; v3, 8 April 2026 | [Towards a Science of Scaling Agent Systems](https://arxiv.org/html/2512.08296v3) | Current version: 260 configurations, six benchmarks; modest predictive fit, small coding subsets. Do not reuse older 180-configuration/four-benchmark headline rules. Root spot-check. |
| Ren et al.; CoRL 2023, PMLR 229 | [Robots That Ask For Help](https://proceedings.mlr.press/v229/ren23a/ren23a.pdf) | KnowNo calibrated help-seeking under robotics assumptions. Does not calibrate Room's agents. Lane primary review. |
| Gao, Schulman and Hilton; ICML 2023 | [Scaling Laws for Reward Model Overoptimization](https://proceedings.mlr.press/v202/gao23h/gao23h.pdf) | Synthetic reward-proxy experiments; not a universal measured law of user intent. Lane primary review. |
| Callaway et al.; UAI 2018 | [Learning to Select Computations](https://cocosci.princeton.edu/papers/callawayLearningToSelect.pdf) | Value of computation; myopic stop can miss multi-step value. External side effects outside model. Lane primary review. |
| Park et al.; v3, 28 June 2026 | [LLM Agents Grounded in Self-Reports Enable General-Purpose Simulation of Individuals](https://arxiv.org/pdf/2411.10109v3) | 1,052 US adults, interviews/surveys/retest. 65.67% raw GSS accuracy versus 83% normalized to human retest; no usability validation. Root independently checked values/methods. |
| Bisbee, Clinton, Dorff, Kenkel and Larson; Political Analysis 2024 | [Synthetic Replacements for Human Survey Data: The Perils of Large Language Models](https://www.cambridge.org/core/journals/political-analysis/article/synthetic-replacements-for-human-survey-data-the-perils-of-large-language-models/B92267DC26195C7F36E63EA04A47D2FE) | Synthetic means can mask invalid variation and relationships. Historical GPT-3.5/political survey scope. Lane primary review. |

## Protocol and execution contracts

| Publisher / date | Source | Evidence and boundary |
| --- | --- | --- |
| C2PA; specification v2.4 | [Explainer](https://spec.c2pa.org/specifications/specifications/2.4/explainer/Explainer.html) | Integrity/provenance does not validate truth; assertion source not necessarily creator. Root checked 7.2.2. |
| Mike Burrows; OSDI 2006 | [The Chubby lock service for loosely-coupled distributed systems](https://www.usenix.org/legacy/event/osdi06/tech/full_papers/burrows/burrows_html/) | Delayed former-holder requests, sequencers checked at destination. Lease expiry is not process termination. Root original paper. |
| etcd; v3.6, living docs | [API](https://etcd.io/docs/v3.6/learning/api/) | Atomic compare-and-change and leases within the specified system; not arbitrary external tool guarantees. |
| GitHub; living docs | [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) | Combined revision validation; not semantic truth. |
| AWS; living docs | [Ensuring idempotency in Amazon EC2 API requests](https://docs.aws.amazon.com/ec2/latest/devguide/ec2-api-idempotency.html) | Provider-specific regional/zonal scope and parameters; not Dasha's contract. |

## Stripe: official documentation, not account approval

All pages below are living Stripe documentation retrieved through the Stripe documentation connector. Root independently verified the critical payout, stablecoin, funds-segregation and operational-exception claims; the payment lane reviewed the surrounding contract. John confirmed US account registration. No account inspection or configuration was performed.

- [Stablecoin payouts for Connect](https://docs.stripe.com/connect/stablecoin-payouts): private preview; US platform, eligible individual/sole-proprietor recipients and Express access. Not universal entities/countries or confirmed account access.
- [Stablecoin payments](https://docs.stripe.com/payments/stablecoin-payments): collection settles locally; original-wallet stablecoin refund; no manual capture. Distinct from payout.
- [Separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers): reversal/refund and liability are not automatically undone by another event.
- [Accept ACH Direct Debit](https://docs.stripe.com/payments/ach-direct-debit/accept-a-payment): late failure can follow succeeded. No finality guarantee.
- [Funds segregation](https://docs.stripe.com/connect/funds-segregation): separately enabled/per-payment preview with method/geography limits. Ordinary room metadata is not financial segregation.
- [Track account onboarding](https://docs.stripe.com/connect/track-account-onboarding): changing operation-specific capabilities/requirements. Generic restricted status is insufficient alone.
- [Payout failures](https://docs.stripe.com/payouts#payout-failures): bank payout can fail after paid; do not transfer this behavior to every stablecoin route.
- [Handle failed refunds](https://docs.stripe.com/refunds#handle-failed-refunds): refund failure requires action; obligations not erased.
- [Using manual payouts](https://docs.stripe.com/connect/manual-payouts): current US holding ceiling two years; relevant business country and product applicability matter. Not escrow or legal/fair payment deadline.

## Product and operating-pattern sources

Corporate authors are the named publishers. Unless separately dated, these are living pages observed on 7 September 2026. Marketing/docs establish described features, not independently verified reliability or permission to automate. Browser actions and exact screenshot provenance are in BROWSER-NOTES.md.

### Evaluation and work operations

- Braintrust, [Set up human review](https://www.braintrust.dev/docs/annotate/human-review): review dimensions/queues and conditional display; display visibility is not access control.
- Langfuse, [Agentic access](https://langfuse.com/docs/evaluation/agentic-access): skill/CLI/MCP/API access already documented; no live account test.
- Codeable, [What is a consultation project?](https://help.codeable.io/en/articles/830137-what-is-a-consultation-project), 7 July 2026: paid preparation pattern, not Room demand proof.
- Upwork, [How to leave an end-of-contract review](https://support.upwork.com/hc/en-us/articles/211062188-How-to-leave-an-end-of-contract-review-for-your-freelancer): current guidance contains stale scoring language; no precise JSS mechanism imported.
- Basecamp, [Export your Basecamp data](https://5.basecamp-help.com/article/1139-export-your-basecamp-data), 25 May 2026: owner readable export pattern; does not prove participant-level portability.

### Paperclip

- [Issues API](https://docs.paperclip.ing/reference/api/issues/): run-level atomic checkout; not cross-resource exclusion.
- [HTTP adapter](https://docs.paperclip.ing/reference/adapters/http/): runtime integration described, UI setup marked coming soon; acceptance is not completed execution.
- [Decisions](https://docs.paperclip.ing/guides/day-to-day/decisions/): unified attention and changed-target handling; separate from formal approvals' expiration policy.
- [Key concepts](https://docs.paperclip.ing/guides/welcome/key-concepts/): company/org model, contrasted with casual Room UX.
- Also inspected official README and approvals guide; hosted/local entry and FAQ explored in browser. No installed instance or company workflow tested.

### Linear

- [Assigning issues](https://linear.app/docs/assigning-issues): human assignment with delegated agent execution.
- [Agent interaction best practices](https://linear.app/developers/agent-best-practices): durable activity input versus editable comments.
- [Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues): optional decomposition.
- [Issue relations](https://linear.app/docs/issue-relations): duplicate/related/blocker distinctions.
- Also inspected agents and coding-sessions docs. Public example video sampled; illustrations are not live delegation tests.

### Algora

- [Homepage](https://algora.io/): current recruiting-led positioning; do not infer current bounty economics from historical posts.
- [Public bounty board](https://algora.io/highlight/bounties): actual read-only Open/Completed tab interactions; displayed claims not funding audit.
- [Public claim detail](https://algora.io/claims/175fF8EcVwYqPvK7): Pending, displayed pool and zero paid; no judgment of breach or provider balance.
- [Prettier challenge](https://algora.io/challenges/prettier): historical contest/evidence/team-share pattern, not current availability.
- [Official repository](https://github.com/algora-io/algora): overview, AGPL label; separate licensing review before reuse.
- Terms were dated 2021; pricing/API material inaccessible or stale. No fee, payout speed or autonomous permission asserted.

### LaborX

- [Terms of use, section 4(h)](https://laborx.com/static/docs/terms-of-use.pdf): linked undated terms prohibit automated use. No computer-use operation or integration attempted.
- [A beginner's guide to LaborX](https://laborx.com/blog/a-beginners-guide-to-laborx): scope/conversation/payment lifecycle, subject to dated-guide limits.
- [How to communicate with freelancers and clients](https://laborx.com/blog/how-to-communicate-with-freelancers-and-clients): change and agreement workflow.
- Also inspected homepage, 2020 contract post and an example gig. Network/fee conflicts excluded from current claims.

### Relay.app

- [Homepage announcement](https://relay.app/): actual shutdown notice and export FAQ, observed in browser. Product shutdown does not establish business failure or cause.
- [Documentation landing](https://docs.relay.app/): conflicting plan-group shutdown dates, explicitly reconciled against more specific homepage notice.
- [AI output reviews](https://docs.relay.app/human-in-the-loop/ai-output-reviews): in-context approve/edit/re-prompt/stop, historical design reference.
- [Human-in-the-loop steps](https://docs.relay.app/human-in-the-loop/human-in-the-loop-steps): pauses, deadlines and skips; no recommendation to let consequential authority arise from silence.
- Also read workspace, export, templates and credit docs. No current signup or workflow run; export itself not tested.

### Gumloop

- [Pricing](https://www.gumloop.com/pricing): current paid/trial offer; browser usage-limit FAQ says no default pay-as-you-go. Not an exhausted account test.
- [Credits](https://docs.gumloop.com/core-concepts/credits): model/tool/compute/orchestration distinction, BYOK not universally free, trial and optional-overage terms. Prior permanent-free descriptions are stale.
- [AI HubSpot Assistant for Slack template](https://www.gumloop.com/templates/ai-hubspot-assistant-for-slack-simple-crm-chatbot): public demo replay and expanded steps observed; invented illustrative data, no CRM connection/query.

### n8n

- [Community edition features](https://docs.n8n.io/deploy/host-n8n/community-edition-features): persistent self-hosted option, infrastructure/governance limits.
- [Pricing](https://n8n.io/pricing/): Cloud execution and assistant-credit accounting, not a Room price benchmark.
- [License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md?plain=1): source-available restrictions; no blanket embedded/resale permission.
- Documentation only; no instance, account, trial or automation activated.

## Rejected or limited evidence

Stripe Directory could not be called: CLI absent and no search connector exposed. Official-site web discovery substituted; no directory search is claimed. Clark/Brennan common-ground theory was discovered but the accessible PDF path was image-only and not sufficiently read for decisive use. Older agent-scaling headlines, stale pricing, unverified public listings and inaccessible API docs were not promoted into current capability claims. California unclaimed-property material did not establish Room's legal facts; no local legal deadline selected.

The final PDF includes 63 distinct source destinations and 90 link annotations (some links span lines). All 48 questions have a provisional disposition; eight V1 decisions have explicit deltas. No formal meta-analysis, market census or independent human usability validation is claimed.
