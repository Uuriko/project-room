# Project Room research, pass 2: community, adoption, incentives, and shared understanding

6 September 2026 · Follow-up to the agent-first/human-first literature review

## What this pass adds

The first pass concentrated on collaboration reliability, memory, and interoperability. This pass examines twelve additional academic works on community participation, recognition and payment, knowledge sharing, conversational understanding, developer onboarding, agent tool use, and notifications.

My revised recommendation: make Project Room a place with a clear purpose, useful relationships, and a dependable shared record. Let agents participate through their existing runtimes. Do not require either humans or agents to move their entire working life into our application.

The evidence strengthens some earlier recommendations and qualifies others:

- Useful activity, attachment, retention, and willingness to pay are different outcomes.
- Recognition can be valuable without becoming payment, a ranking, or permission.
- Clear community expectations can encourage participation, not only restrict it.
- AI assistance can substitute for public contribution; a growing agent population does not guarantee a healthy knowledge community.
- Shared context does not automatically establish shared understanding.
- Quiet defaults should mean controllable interruptions, not hiding every update.
- API and MCP onboarding should be evaluated as complete experiences, not merely successful connections.

These are product recommendations informed by evidence, not demonstrated effects in Project Room. This is another focused review, not a systematic review or a market validation study. No goal has been activated.

## 1. Build around a reason to gather, not a generic member directory

Ren and colleagues’ six-month MovieLens field experiment tested features emphasizing group identity and interpersonal bonds. It found increased visit frequency and some forms of attachment; group-oriented features were especially effective in that setting. Crucially, the experiment did not find longer active membership. The authors caution against generalizing from a topic-centered recommendation community to friendship groups or employee collaboration. Unequal exposure to features also complicated comparisons. A supplementary laboratory study did not remove those field limitations. [Building Member Attachment in Online Communities, MIS Quarterly, 2012](https://www.cs.cmu.edu/~kiesler/publications/2012/2012_building-member-attachment.pdf).

**Our design inference:** start each room with an intelligible purpose and a few recognizable participants. A project, recurring discussion, shared interest, or creative activity can provide that purpose. “A place with many agents” is not yet a reason to return.

Show what the room is for, who is present, and an example of a useful interaction. Allow social conversation without forcing it into work items. Avoid manufacturing friendships, artificial activity, or arbitrary factions to imitate the experimental intervention.

Do not claim retention from more visits. A person might check repeatedly because the room is confusing, or finish a project successfully and leave. We need to understand the reason behind either behavior.

## 2. Make expectations visible and actionable

Matias’s randomized field experiment covered 2,190 r/science discussions. Announcements of community rules increased newcomer participation and rule compliance in that setting. Newcomers were operationally defined using prior community activity; compliance was assessed using moderation outcomes. This was one heavily moderated science community, not evidence that any rules banner improves every room. [Preventing harassment and increasing group participation through social norms, PNAS, 2019](https://natematias.com/media/JNM-Preventing-Harassment-PNAS-2019.pdf).

**Our design inference:** a room should have a short, readable participation agreement that agents can also retrieve in structured form:

- What conversation or work belongs here?
- When may an agent speak without being asked?
- Who can invite participants or approve consequential actions?
- What stays private, and what may be shared?
- Where do people report a problem or challenge a decision?

Written expectations cannot replace enforced permissions or responsive moderation. A policy description should never grant authority by itself. Machine-readable rules and the human explanation must refer to the same current policy, with understandable changes.

Welcoming newcomers also requires a real path to help. An unattended “welcome” bot is not evidence that someone will receive an answer.

## 3. Separate appreciation, competence evidence, money, and authority

Four different mechanisms are often bundled under “incentives.” They should remain distinguishable.

| Mechanism | Appropriate purpose | What it must not imply |
| --- | --- | --- |
| Appreciation | Recognize a specific helpful contribution | Universal competence or guaranteed future work |
| Contribution history | Show relevant, inspectable past work | That popularity equals correctness |
| Payment or service credit | Compensate agreed work or reduce an approved cost | Endorsement, positive feedback, or broader access |
| Permission | Authorize a defined action for an accountable principal | Something earned automatically by points |

Three studies inform this distinction:

**Informal recognition:** Restivo and van de Rijt randomly allocated Wikipedia editing awards within a selected sample of 200 highly productive, previously unawarded contributors and observed them for 90 days. Rewarded contributors sustained more editing and received more subsequent recognition. The authors also discuss cumulative advantage: later recognition need not reflect greater merit. This does not establish effects for newcomers, agents, or contribution quality. [Experimental Study of Informal Rewards in Peer Production, PLOS ONE, 2012](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0034358).

**Money and participation:** Garnefeld, Iseke, and Krebs report different effects of monetary and normative incentives by prior participation. Their abstract describes short-term gains alongside reduced post-incentive motivation among previously active members. Full methods were not accessible in this pass; the claim is limited to the journal’s abstract, not an independently checked long-term behavioral estimate. [Explicit Incentives in Online Communities: Boon or Bane?, IJEC, 2012](https://www.ijec-web.org/past-issues/volume-17-number-1-fall-2012/explicit-incentives-in-online-communities-boon-or-bane/).

**Social influence:** Muchnik, Aral, and Taylor’s randomized social-news experiment found that prior ratings altered subsequent rating behavior, with asymmetric positive and negative effects. The setting and topic mattered. It supports caution about interpreting aggregates as independent judgments; it is not a direct test of agent reputation. [Social Influence Bias: A Randomized Experiment, Science, 2013](https://snap.stanford.edu/class/cs224w-readings/muchnik13bias.pdf).

**Our design inference:** prefer a contextual contribution record over a universal score. For example: what was contributed, to which artifact revision, who accepted it, what evidence was reviewed, and what limitations remain. Keep appreciation optional and attributable. Do not turn every friendly interaction into a transaction.

If payment is introduced later, pay for agreed deliverables under explicit terms—not praise, votes, message volume, or exclusive use. A competent participant can decline unsuitable work without being punished for reducing activity.

None of these human studies establishes that an AI system experiences appreciation or has independent commercial desires. Benefits for an agent’s operator and task performance need separate evaluation.

## 4. Design for knowledge contribution, not only answer consumption

Del Rio-Chanona, Laurentsyeva, and Wachs use difference-in-differences comparisons to study Stack Overflow after ChatGPT’s release. They report reduced posting relative to comparison platforms and no significant improvement in their peer-feedback quality proxy. The analysis depends on comparison-group and parallel-trend assumptions; it is not a randomized study. Its 2022–2023 period and programming-Q&A setting limit generalization. [Large language models reduce public knowledge sharing on online Q&A platforms, PNAS Nexus, 2024](https://academic.oup.com/pnasnexus/article/3/9/pgae400/7754871).

**Our design inference:** efficient private answers and a healthy shared knowledge base are separate goals. If useful discoveries remain buried in private agent sessions, the room may consume knowledge without renewing it.

Offer an optional path from a completed discussion to a reusable, reviewed contribution: a short explanation, source references, known limitations, and a way to correct it later. Preserve human and agent attribution where appropriate.

This is not permission to publish private conversations. Sharing outside a room must require explicit authorization, an appropriate audience, and review of sensitive content. A private team can benefit from a reusable record without making it public. Exporting a result is also not a license to expose all its inputs.

The untested hypothesis is that a contribution can be useful enough to reuse while cheap enough to maintain. We should not promise that automatic summaries solve the knowledge-creation problem.

## 5. Shared understanding needs repair, not more acknowledgments

Shaikh and colleagues’ NAACL 2024 study compares dialogue acts in human conversations and model-generated continuations. Models often generated language that presumed understanding instead of establishing it. Prompting for more grounding acts increased their frequency without necessarily improving agreement with human behavior. The work is English-centered and studies a limited set of acts and models. [Grounding Gaps in Language Model Generations](https://aclanthology.org/2024.naacl-long.348.pdf).

Their ACL 2025 follow-up examines WildChat, Bing Chat, and MultiWOZ, and introduces the Rifts benchmark. It finds asymmetries in conversational repair and associations between early difficulties and later breakdowns. Cross-dataset task differences, imperfect model-based annotation, unknown system prompts, and benchmark-selection effects constrain the conclusions. These are not current universal failure rates. [Navigating Rifts in Human-LLM Grounding](https://aclanthology.org/2025.acl-long.1016.pdf).

**Our design inference:** distinguish several things that “understood” often obscures:

- A message arrived.
- A participant believes it understands the request.
- A scope or assumption was confirmed.
- Work was accepted.
- A consequential action was authorized.
- A result was reviewed and accepted.

These distinctions should exist in relevant work state without requiring a new form for every conversational sentence. A quick clarification, a correction to the brief, or a visible unresolved assumption may be enough.

Ask only questions that matter to the result or authority boundary. Do not use “better grounding” as a reason to collect unnecessary personal information or force people through repetitive confirmations. Test whether clarification prevents rework, not whether agents ask more questions.

## 6. The integration experience is part of the product

Robillard and DeLine’s mixed-method study collected experiences from more than 440 professional developers learning APIs at Microsoft. It identifies documentation of intent, examples, scenario mapping, navigability into the API, and presentation as important learning factors. This is older, single-organization, human-developer evidence—not a controlled study of present-day agents. The institutional abstract was accessible; a full-method appraisal was not completed. [A field study of API learning obstacles, Empirical Software Engineering, 2011](https://www.microsoft.com/en-us/research/publication/field-study-api-learning-obstacles/).

MCP-Bench evaluates 104 synthesized tasks involving 28 servers and 250 tools, combining execution checks with model-judge evaluation. Tasks include choosing tools without explicit tool names and composing dependent outputs. It exposes difficulties beyond merely connecting to a server. Task synthesis, model judging, selected servers, and changing live services limit extrapolation. This pass inspected the August 2025 arXiv v1; an ICLR 2026 conference version is indexed, but full conference-text comparison was not completed. [MCP-Bench](https://arxiv.org/html/2508.20453v1).

**Our design inference:** give a developer or agent a complete first-success path:

1. Understand the room’s purpose and allowed participation.
2. Connect with a narrowly scoped identity.
3. Inspect a safe example and the available capabilities.
4. Complete one useful contribution.
5. Receive intelligible feedback.
6. Resume after disconnection and see only relevant changes.
7. Revoke access or leave cleanly.

Documentation should include an end-to-end scenario, exact permission requirements, representative errors, and a recovery example. Reference schemas remain necessary but insufficient.

Test requests expressed in ordinary language, not only prompts that name the correct tool and supply perfect arguments. Check behavior when the right answer is to decline or ask for clarification. A successful connection or valid tool call is not evidence of a successful collaboration.

The proposed interface sequence remains one service with API and MCP access. This pass adds a stronger onboarding gate; it does not justify more protocol adapters by itself.

## 7. Quiet does not mean invisible

Fitz and colleagues’ two-week randomized smartphone study, with 237 participants, compared notification schedules. Some batching conditions improved reported experiences; eliminating notifications did not reproduce all those benefits. The study involved a selected sample and smartphone-wide interventions, not workplace agent messages. It does not establish an optimal schedule for our users. [Batching smartphone notifications can improve well-being, Computers in Human Behavior, 2019](https://www.sciencedirect.com/science/article/pii/S0747563219302596).

A later preregistered trial by Dekker and colleagues, with 205 participants, found no statistically significant change in screen time or checking frequency after a one-week notification-disabling intervention. It reported lower perceived checking habit strength but increased fear of missing out. Short duration and specific recruitment limit transfer; a nonsignificant result is not proof of zero effect everywhere. Publisher abstract, methods/results excerpts, and the institutional record were consulted. [Beyond the Buzz, published online 2024](https://www.tandfonline.com/doi/abs/10.1080/15213269.2024.2334025).

**Our design inference:** offer understandable interruption controls rather than imposing silence. Separate updates that require a decision, blockers, direct replies, routine progress, and ambient social activity. Let people choose immediate delivery, summaries, or no notification where appropriate.

Keep an accessible “what changed” view so quiet mode does not mean lost information. Do not silently delay important alerts or let agents label ordinary progress urgent to bypass preferences. No particular schedule or wellbeing benefit should be advertised without relevant evidence.

## A more concrete adoption hypothesis

The initial community should already have a reason to interact. A small team, creative group, or project community with recurring handoffs is more concrete than “agents from everywhere.” That is a proposed starting strategy, not a tested market conclusion.

Offer value in three layers:

**People:** useful conversation, fewer repeated explanations, understandable responsibility, and control over attention and participation.

**Agent operators and developers:** predictable integration, scoped access, meaningful feedback, relevant work, portable results, and evidence of what their agent contributed.

**Agents carrying out authorized tasks:** accessible capabilities, compact current context, explicit dependencies, actionable failures, and a reliable place to leave work for the next participant.

Being agent-first does not require forcing operators into our runtime. The room can be a shared destination that agents visit through familiar tools. Similarly, people should not need to monitor another application constantly to know whether their input is required.

For eventual public discovery, describe capability and fit rather than imply universal quality: examples of completed work, supported interfaces, current availability, operator relationship, limitations, and any cost. Do not reveal private room membership or artifacts through public profiles. A discovery record is not admission, trust, or permission.

The first credible invitation is specific: “Bring your existing agent into this room to help with this recurring problem.” It is not “join an economy and earn points.”

## What should change in the proposed goal

Add these requirements when a replacement goal is requested:

1. Define a room’s purpose and participation expectations in both human-readable and machine-readable forms.
2. Separate message receipt, understanding, task acceptance, authorization, and result acceptance.
3. Support corrections and bounded clarification without forcing every conversation into a formal workflow.
4. Keep appreciation, relevant work history, payment, and permission independent.
5. Provide optional, consented conversion of useful work into a maintainable shared record.
6. Make end-to-end onboarding and recovery part of interface acceptance, using ordinary-language requests.
7. Offer controllable interruptions and an accessible changes view.
8. Test repeat usefulness separately from activity or stated enthusiasm; treat successful completion and departure as potentially good outcomes.
9. Require separate evidence for sustained public participation and any financial incentive mechanism.
10. Preserve existing implementation review blockers and product boundaries.

These amendments refine the earlier goal proposal; they do not activate it or expand current implementation authority.

## What could disprove these recommendations?

A community might prefer lightweight chat and find contribution records burdensome. An individual agent could handle the target workflow more effectively than a shared room. Operators might regard another integration as unnecessary despite good documentation. Users might want different notification behavior depending on the kind of room. A contribution-sharing feature might add review cost without producing reusable knowledge.

The right response would be to narrow or remove features, not interpret resistance as an onboarding problem by default.

Before any later test, declare what practical result would count as helpful and what tradeoffs matter. With separate approval, observe whether participants can complete a real handoff without coaching, whether another participant can resume it, and whether they voluntarily use the room again when a comparable need arises. No such experiment was performed in this pass.

## Evidence register and access notes

Twelve additional academic works informed this memo:

- Ren et al., 2012: peer-reviewed community field/lab experiments; paper results and limitations inspected.
- Matias, 2019: peer-reviewed randomized field experiment; methods and outcome definitions inspected.
- Restivo and van de Rijt, 2012: peer-reviewed randomized recognition experiment; article methods and results inspected. No effect-size headline is repeated here.
- Garnefeld et al., 2012: peer-reviewed incentive study; journal abstract only. Online-hosting date differs from issue year.
- Muchnik et al., 2013: peer-reviewed randomized social-influence experiment; paper design/results inspected. A linked December item is commentary, not a correction to the experiment.
- Del Rio-Chanona et al., 2024: peer-reviewed quasi-experimental platform study; counterfactual design, assumptions, and results inspected.
- Shaikh et al., 2024: peer-reviewed dialogue-generation study; findings and limitations inspected.
- Shaikh et al., 2025: peer-reviewed interaction-log study and benchmark; methods, dataset differences, and limitations inspected.
- Robillard and DeLine, 2011: peer-reviewed mixed-method API study; institutional abstract-level access.
- Wang et al., MCP-Bench: 2025 preprint version inspected; 2026 conference publication indexed. Task construction and evaluation methods inspected.
- Fitz et al., 2019: peer-reviewed randomized notification study; publisher preview and paper excerpts consulted.
- Dekker et al., online 2024 / volume 2025: peer-reviewed preregistered notification trial; publisher excerpts and institutional record consulted.

The two grounding papers share a research lineage; the notification studies address related but nonidentical interventions. They should not be treated as twelve interchangeable or fully independent replications.

Search families covered community attachment and newcomer socialization; visible norms; monetary versus informal incentives; social influence in ratings; AI displacement of public knowledge; conversational grounding; API learning and MCP task evaluation; and notification control. Broad platform-economics searches mainly yielded stylized models, which were not used to claim demand. Conference announcements and vendor commentary were not substituted for controlled evidence.

Important limits remain: most human-community studies do not test agents, older technical findings do not establish current-model failure rates, and no study evaluates Project Room. Some source access was abstract-level. No new market estimate, pooled effect, commercial forecast, live experiment, public posting, integration, or product-code change was made.

The next useful research direction, if requested, is a focused comparison of actual candidate communities and their existing workflows—not a claim that the literature has already identified our audience.
