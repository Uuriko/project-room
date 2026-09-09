# Project Room: research, product direction and 112 possible next tasks

September 8, 2026. Research and planning, not a release or authorization to run
the backlog. Runtime baseline: `975f5e556af6dc764ab13659d7509d104525ce84`.

## Recommendation

Make Project Room the place where a person can bring a goal, connect the AI they
already use, and return to a useful result with a clear next decision. The product
should remove the need to forward context between people and agents. It should
not require people to learn an agent-management system before getting help.

The durable advantage to pursue is **continuity across people, agents and tools**:
shared context, clear responsibility, recoverable handoffs, versioned results and
fair recognition. A marketplace can grow out of useful work already happening
here. It need not be the first screen or the first successful business model.

This is a prioritized option set, not 112 commitments. Keep one complete product
slice active and one bounded research/release lane. Finish, simplify and evaluate
before expanding. Do not interpret this document as permission to deploy, enroll
providers, run paid models, recruit people, issue rewards or start recurring work.

## 1. Where we actually are

The local product already has durable conversation, shareable invitations,
account/member boundaries, short contextual controls, desktop Enter-to-send,
work ownership, scope claims, blockers, evidence, independent review and owner
decisions. Portable task packets and manually returned AI drafts support tools
that cannot connect directly. Managed agent identities, direct/API/CLI/local MCP
paths, scoped discussion reads, versioned native text results, room instructions
and optional private current-attention journals have been added locally.

The latest checkpoint adds explicit reply-request rules, current/selected/history
reads and agent operations. **Human request controls and request-specific attention
are unfinished.** The ordinary browser UI has not gained that feature yet.

| Evidence boundary | Current position |
|---|---|
| Local runtime | Schema/writer 12; 24 default MCP tools, 26 with existing optional attention |
| Latest qualification | 510 core/API/package checks; 159 browser regressions; 13 local Workers checks passed |
| Request testing | Scripted HTTP/CLI/MCP journeys; not yet a complete human/actual-agent request acceptance exercise |
| Earlier actual-agent testing | Separate agents produced and reviewed original artifacts; controlled, coordinator-started local fixtures |
| Native vendor hosts | Setup routes documented; not a completed acceptance matrix |
| Live | Last recorded fb90a70 / Worker 901be347 / schema 7; untouched and not reverified in this research |
| Hosted AI, remote OAuth MCP, execution runner, money | Not delivered by the current checkpoint |
| Human usability/retention | Simulations and regressions are not human research or retention evidence |

The large local/live gap is now a product risk. More local capability does not
help invited users until a coherent, recoverable release is qualified and
separately authorized. Do not downgrade a migrated database to an older writer.

Internal context reviewed: long-running goal, first workflow, current handoff,
workspace roadmap, agent-host guide, reply-request plan, bounty design, quiet
interface checkpoint and testing system. Historical documents contain old schema,
tool-count and implementation claims; the current checkpoint takes precedence.

## 2. Research method and limitations

First pass asked what prevents an excellent core workflow: connection friction,
context continuity, collisions, review burden, recovery and interface complexity.
Second pass challenged expansion assumptions: whether more agents improve work,
whether human review always helps, whether monetary rewards alone create supply,
and whether work trade should copy a time-credit economy.

Sources were official protocol/product documentation, original scholarly paper
abstracts/publication summaries and Stripe's documentation connector. This is not
a full reading of every paper, an exhaustive competitor audit, or a code/license
audit. Product documentation describes intended behavior, not independently
measured reliability or adoption. Studies use particular models, tasks and samples;
their effect sizes are not forecasts for Project Room. No competitor accounts were
created or operated in this pass. Algora's API reference failed to open, so it did
not support a substantive conclusion below. Apple onboarding content was available
in the search extract but its page body required JavaScript; that is a weaker read
than the other opened sources.

Two existing fresh local regression screenshots were inspected: desktop
conversation and enlarged-text mobile recovery. They show real rendered fixture
states, not new human sessions. See the checkpoint for paths and limitations.

## 3. Findings that change the plan

### A. Coordination is a product capability, not an agent-count setting

MAST categorizes failures into system design, inter-agent alignment and task
verification, based on annotated multi-agent traces. A separate controlled study
finds that coordination performance depends strongly on task structure, with
overhead and error propagation varying across architectures. Neither supports
automatically adding more workers to every problem.
[MAST, v3](https://arxiv.org/abs/2503.13657),
[Scaling agent systems, v3](https://arxiv.org/abs/2512.08296).

Our inference: start with one accountable performer, add a reviewer when useful,
and parallelize genuinely separable scopes. Treat contested ownership, unresolved
dependencies and repeated handoff loops as visible conditions. An agent that
declines unsuitable work or returns a useful blocker can improve the room.

### B. Human-first means valuable control, not compulsory clicks

The human–AI meta-analysis reports that combinations did not, on average, beat
the better standalone participant; results varied by task, with more promising
findings for content creation than decision tasks. Microsoft's interaction work
offers evaluated design guidance across initial use, interaction and failures.
These are reasons to test the allocation of work, not to remove human authority.
[Meta-analysis](https://arxiv.org/abs/2405.06087),
[Human–AI interaction guidelines](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/).

Our inference: distinguish ordinary authorized contribution from consequential
decisions. Show the exact result, relevant change and unanswered question. Let
people correct, pause and redirect. Avoid asking them to approve every internal
step or interpret a stream of tool output.

### C. Broad connectivity needs honest capability negotiation

The July 2026 MCP revision changes discovery, request metadata, notifications and
task-extension behavior. Our adapter is explicitly the older 2025-11-25 tools-only
stdio contract. Changing its advertised date is not an upgrade. OpenAI's Responses
API documents remote MCP tooling, allowed-tool filtering and approval controls;
that does not prove a local Room adapter works in a specific ChatGPT interface.
[MCP changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
[OpenAI remote MCP](https://developers.openai.com/api/docs/guides/tools-connectors-mcp).

Our inference: maintain a tested compatibility matrix. Separate manual handoff,
local tools, authenticated HTTP and remote MCP. Prefer a small number of proven
connection paths over a logo wall. Keep business operation IDs independent of
transport request IDs so transport retries cannot duplicate work.

### D. Borrow interaction patterns, not another product's entire object model

Linear makes agent sessions and requests for input visible in existing workflows.
Paperclip distinguishes triggers, routines, execution history and configuration;
its documentation includes dormant-agent and bounded scheduling concepts.
[Linear agent interaction](https://linear.app/developers/agent-interaction),
[Paperclip routines](https://docs.paperclip.ing/guides/projects-workflow/routines/).

Our inference: keep Room work canonical. A runtime session explains an attempt;
it is not a second definition of work completion. Room messages must not silently
start inference just because another product uses mentions as triggers. Expose
useful progress summaries, not private internal reasoning.

### E. Durable questions are the bridge between conversation and automation

LangGraph's interrupt documentation requires persisted state and a stable identity
to resume a paused workflow. A2A distinguishes tasks, follow-ups and artifacts,
and leaves artifact lineage management to clients.
[LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts),
[A2A task lifecycle](https://a2a-protocol.org/latest/topics/life-of-a-task/).

Our inference: finish our reply-request slice before a general automation builder.
Persist what is waiting, whose input is needed and the version that input applies
to. A2A can later map external attempts into Room work; do not force Room's review
and owner-decision states into a mismatched remote task lifecycle.

### F. Progressive disclosure applies to agents as well as people

Anthropic recommends evaluating tools on actual tasks, reducing ambiguity and
controlling response size. Agent Skills describes staged loading of metadata,
instructions and supporting resources. Apple encourages onboarding through use
and keeping necessary onboarding brief and optional.
[Tool design](https://www.anthropic.com/engineering/writing-tools-for-agents),
[Skills specification](https://agentskills.io/specification),
[Apple onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding).

Our inference: a newcomer gets a conversation and an obvious next action; an
agent gets identity, a small relevant work list and selected context. Neither
should receive every feature or the entire room history by default. Shortened
agent responses must retain the IDs and revision anchors needed for safe action.

### G. Rewards should pay for accepted value, not visible busyness

Superteam's agent interface separates agent submissions from a human payout claim.
An older observational study of Bountysource associated earlier bounty placement
and repeated use with issue resolution; it is not causal evidence about today's
agent economics. Mercor's support material makes project contacts, onboarding and
work access explicit parts of the contributor experience.
[Superteam agents](https://superteam.fun/earn/agents),
[Bountysource study](https://arxiv.org/abs/1904.02724),
[Mercor project support](https://talent.docs.mercor.com/support/project).

Our inference: start with real demand, clear acceptance criteria, a responsive
sponsor and a known reviewer. Borrow task readiness and accountable support from
Mercor, not an entire recruitment funnel. Separate producer, contributor, reviewer
and payment recipient. Do not reward tokens, message volume or unverified runtime.

### H. Work trade is promising, but agent time is not human time

TimeBanks describes reciprocal service credits, with equal value per human hour
and exchange across a community rather than only between two people.
[TimeBanks FAQ](https://www.timebanks.org/faq).

Our inference: test explicit bilateral exchanges first—"review my draft and I will
test your app"—with two linked deliverables and no invented monetary balance.
Do not equate a parallel agent-hour with an hour of a person's attention. A shared
credit economy would require separate economic, abuse and legal investigation.

### I. Fiat collection and stablecoin distribution are separate gates

Stripe's current Connect documentation says stablecoin payouts are a private
preview for US platforms, with recipient and Dashboard restrictions. Its stablecoin
acceptance documentation separately describes settlement and refund behavior.
US registration alone does not establish that our account has payout access.
[Connect stablecoin payouts](https://docs.stripe.com/connect/stablecoin-payouts),
[Stablecoin acceptance](https://docs.stripe.com/payments/stablecoin-payments).

Planning implication: confirm our actual eligibility before promising supported
currencies or countries. Work acceptance, funding confirmation, release authority
and money received must remain distinct. Payment configuration, liability, tax,
contractor classification and real-world-task obligations need qualified review;
this document does not select a Stripe configuration or give legal conclusions.

### J. Cross-agent review is real, but different branding is not independence

A recent empirical AI-to-AI review paper studies both same-product and cross-product
review and explicitly cautions about attribution, task composition and timestamp
limitations. It does not establish that a mixed-vendor pair is better at finding
defects.
[AI-to-AI code review](https://arxiv.org/abs/2608.21311).

Our inference: evaluate reviewers against exact artifacts and known criteria.
Record disagreements and useful defect findings; do not use comment counts or
vendor diversity as a quality guarantee. Protect review capacity from low-quality
submission floods.

## 4. Questions we still need to answer

These are unresolved decisions, not missing permission to continue ordinary
research. Use the proposed experiment rather than asking John all of them at once.

| Question | Working position | Evidence or decision needed |
|---|---|---|
| What is the first repeatable job? | Shared production/review of a small digital result | Compare code, research and writing journeys without changing all three at once |
| Why Room instead of chat plus GitHub? | Less forwarding; clearer result and next actor | Count actual relays and reconstruction steps in paired fixtures |
| What makes someone return? | A useful result or decision, not unread volume | Later consented human observation; simulations cannot prove retention |
| What attracts an agent? | Relevant work, cheap context, clear rules, dependable feedback | Actual-agent task choice and completion tests |
| Can agents initiate work? | Propose or discover inside an existing grant | Test out-of-scope refusal and duplicate proposals |
| Who is responsible for an agent? | Visible sponsoring operator | Ownership-transfer and revocation design |
| What does connected mean? | Verified access/contact, not running | Native-host checks and explicit state vocabulary |
| What deserves a wakeup? | A current actionable condition | Noise/coalescing tests; no self-perpetuating acknowledgements |
| When should agents parallelize? | Only separable work with bounded coordination | Equal-budget solo/pair comparison |
| Can claims stop external collisions? | Not without enforcement at the resource boundary | Fake-runner fencing test, then authorized adapter proof |
| Who checks the checker? | Criteria, evidence and dispute/escalation paths | Seeded benign correctness errors and blind verdict evaluation |
| What is a completed result? | Exact accepted bytes/version plus intended outcome | Distinguish answer, submission, verification, owner acceptance and publication |
| What memory should persist? | Curated sourced state, not all transcripts | Changed/contradictory source and private-context tests |
| How can a human correct an agent? | Explicit change of direction with scope/version | Preserve drafts and invalidate only affected work |
| Do we need A2A immediately? | No; prove existing paths first | A concrete external consumer that requires it |
| Should we build a visual workflow editor? | Not yet | Repeated workflows that cannot be expressed by a small recipe |
| What remains free? | Useful manual/BYO collaboration | Costed entitlement design; no invented unlimited promise |
| What should hosted AI sell? | Convenient bounded assistance, not basic access to one's work | Measured cost and willingness-to-pay research later |
| Is review the marketplace bottleneck? | Plausible, not measured | Track queue size, review effort and revision churn in a small pilot |
| Who pays for partial or changed work? | Agreed terms before starting | Sponsor/contributor policy decision and payment review |
| Can a reward fund several contributors? | Later, with explicit allocation | Multi-party acceptance and disagreement scenarios |
| What can be public? | A reviewed brief/result, never an automatic room export | Audience-preview and inherited-source permission tests |
| What real-world tasks are acceptable? | Narrow low-risk categories first | Legal, safety, insurance, location/privacy and support policy review |
| Is work trade a ledger or a social agreement? | Start with an explicit two-sided agreement | Failure/cancellation test and observed demand before shared credits |
| Can unused subscription capacity be automated? | Only within operator/provider limits | Per-host terms, permissions and reliable quota evidence |
| How much should we build before a pilot? | One complete loop and release recovery | A release gate, not an arbitrary feature count |

## 5. Sequencing and anti-sprawl rules

**P0 — finish and qualify:** necessary to complete the current slice or evaluate a
safe invite-only candidate. **P1 — deepen the core:** next after the relevant P0
gate. **P2 — optional expansion:** needs a scoped implementation plan and evidence
of demand. **P3 — experiment:** validate before committing to product or economics.

These priorities are judgment calls, not estimated ROI scores. No credible delivery
dates or effort estimates exist yet for all 112 items. Size the selected slice
after its design review; don't make a timeline from this list's length.

1. **Finish requests:** human create/clarify/answer/decline/cancel, draft ownership,
   current attention and actual-agent resumption. Exit: a complete interrupted
   human/agent exchange without root forwarding or false completion.
2. **Qualify an invite-only release:** exact package, populated migrations,
   compatible fallback, restore/current authority, honest hosted verification.
   Local preparation can proceed; publication needs explicit authorization.
3. **Prove easy connection and return:** two real native hosts, manual fallback,
   calm mobile UI and a useful catch-up. No claim of universal compatibility.
4. **Add bounded initiative and workspace execution:** eligible work, standing
   permissions, isolated attempts and fake-runner recovery; then an authorized
   Dasha adapter. A reviewer and one performer are sufficient to start.
5. **Pilot rewards and repeatable help:** private sponsored tasks first, gated
   payment integration, then public discovery and real-world/trade experiments.

Every new capability must reuse the room/work/result/identity model where suitable,
have a visible place in an existing flow, define its failure/stop path, and name
what it replaces or why existing controls cannot do the job. Do not silently
reinterpret old events, recovery files or user permissions to save code.

## 6. The task backlog

Each item is a candidate with a concrete completion check. Existing foundations
are being completed or extended, not proposed as entirely new systems.

### A. Finish explicit reply requests — P0

1. **A1 · Request in the composer.** Add a contextual recipient/request mode. Done when ordinary chat stays ordinary and one recipient can be selected without a new screen.
2. **A2 · Answer, clarify, decline, cancel.** Reuse conversation controls with role-appropriate actions. Done when answering cannot accidentally mean accepting work or approving payment.
3. **A3 · Own every draft.** Bind text to the exact room, request and mode. Done when switching between requests never silently retargets unsent text.
4. **A4 · Recover uncertain sends.** Preserve the original operation through supported interruption paths. Done when retry cannot duplicate or rebase an answer silently.
5. **A5 · Surface request attention.** Add an explicitly selected new observer format without rewriting v1/v2. Done when acknowledgements affect only the exact local notice.
6. **A6 · Recover missed exchanges.** Combine current attention with anchored historical reading. Done when a question answered entirely between polls remains discoverable.
7. **A7 · Test actual disconnected agents.** Have an agent ask, reconnect, read clarification and answer; a separate participant checks it. Done without root composing the answer or forwarding context.
8. **A8 · Test the human path.** Simulate desktop, touch, large text, keyboard/IME and changed-context cases; inspect screenshots. Done with evidence labeled simulation, not human usability validation.

### B. Close the local-to-live gap — P0

9. **B1 · One release inventory.** Record each capability as local, qualified, live or unknown. Done when stale historical plans cannot be mistaken for current availability.
10. **B2 · Frozen candidate manifest.** Pin runtime, assets, schema and package hashes. Done when tests and deployment preparation refer to the same bytes.
11. **B3 · Populated migration rehearsal.** Preserve genuine older room histories through the selected schema. Done when rollback-on-failure and old-writer refusal are demonstrated.
12. **B4 · Compatible fallback.** Qualify a schema-12-aware fallback on migrated data. Done without database downgrade or assumptions that an old binary is safe.
13. **B5 · Restore rehearsal.** Verify backup restoration plus membership, grants, history and observer reconciliation. Done when stale restored authority cannot silently be treated as current.
14. **B6 · Invite-only operating checklist.** Check access controls, indexing, logs, support and incident ownership. Done when an unlinked URL is not the sole privacy boundary.
15. **B7 · Hosted acceptance plan.** Prepare new-member, two-agent, reconnect and restore checks for an authorized deployment. Done when required credentials, owner actions and expected evidence are explicit.
16. **B8 · Release and rollback decision.** Present remaining risks and request publication authority at the release boundary. Done only after separately authorized hosted checks, not from local tests alone.

### C. Make the interface feel lighter — P1, alongside P0 where directly relevant

17. **C1 · Shorten the mobile header.** Move infrequent identity/session actions into an accessible menu. Done when conversation is reachable sooner without hiding access loss.
18. **C2 · One primary work action.** Show the current result and next required action before secondary controls. Done when expanded details do not compete with the main task.
19. **C3 · Quieter message actions.** Reveal secondary actions on selection/focus as well as pointer interaction. Done when touch and keyboard users lose no capability.
20. **C4 · Reduce routine notices.** Reserve persistent alerts for unresolved actionable states. Done when success notifications do not cover catch-up or composer controls at large text.
21. **C5 · Explain visibility only where needed.** Keep audience evident at sending/sharing boundaries; consolidate repetition. Done when users can still distinguish room-visible from private content.
22. **C6 · Result-first catch-up.** Group by outcome, question, blocker and decision instead of raw event volume. Done when each summary opens its exact supporting state.
23. **C7 · Consistent progressive disclosure.** Harmonize Details, Options, About and contextual menus. Done when equivalent controls have predictable placement and focus behavior.
24. **C8 · Calm visual polish.** Review spacing, text hierarchy, contrast and motion in common states. Done when icons have accessible names and minimal copy has not made actions ambiguous.

### D. Make connections genuinely easy — P1 unless marked P2

25. **D1 · Capability-first setup.** Ask whether the tool can use local MCP, HTTP or only text. Done when setup offers the shortest supported route rather than a vendor-name assumption.
26. **D2 · Versioned host matrix.** Record exact host/protocol versions and tested operations. Done when documented, installed and actually working are separate statuses.
27. **D3 · First two native hosts.** Exercise discovery, approval, selected read, contribution, expiry and restart. Done with real host evidence, not only an MCP subprocess test.
28. **D4 · Connection doctor.** Provide a read-only access/protocol/permission check and one useful repair step. Done without dumping secrets or reading all room history.
29. **D5 · Modern MCP compatibility.** Design and test genuine version negotiation and new lifecycle behavior. Done when both supported eras work without changing business retry identity.
30. **D6 · Remote MCP/OAuth — P2.** Add hosted connection with consent, limited grants and revocation. Done after native hosted-client tests; an HTTP API URL alone does not qualify.
31. **D7 · Portable return upgrades.** Make copyable briefs and manual results effortless to correlate. Done when manual provenance stays explicit and no key is pasted into a prompt.
32. **D8 · Public developer contract.** Reconcile API/MCP examples, errors, versions and capability descriptions. Done when an unfamiliar agent can complete a bounded task using only those materials.

### E. Prevent agent collisions and improve delegation — P1/P2

33. **E1 · Eligible-work discovery — P1.** Return permitted unclaimed work and the reason it fits. Done without silently assigning, starting or exposing private rooms.
34. **E2 · Standing permission profiles — P1.** Extend existing sponsorship with understandable contribution/review limits. Done when changing the brief cannot grant more authority.
35. **E3 · Work-intent preview — P2.** Let a worker describe the intended scope before editing. Done when likely overlap is surfaced without pretending similarity is a lock.
36. **E4 · Explicit resource claims — P1.** Make current claims and contention easier to discover. Done when two agents can divide work or hand off without root relaying state.
37. **E5 · Enforced fencing — P2.** Carry ownership generation through controlled execution boundaries. Done when an expired worker cannot write through our adapter after reassignment.
38. **E6 · Dependency-aware next steps — P2.** Represent a small dependency graph behind ordinary work cards. Done when cycles and unavailable prerequisites are visible.
39. **E7 · Bounded child delegation — P2.** Preserve parent scope, budget, deadline and accountable operator. Done when a child cannot widen its authority or hide unfinished work.
40. **E8 · Stop coordination loops — P1.** Detect repeated duplicate proposals, acknowledgement chains and unproductive handoffs. Done with a clear pause/escalation path rather than perpetual agent chatter.

### F. Make room memory and results genuinely useful — P1/P2

41. **F1 · Current context packet — P1.** Assemble selected task, current brief, relevant decisions and exact result pointers. Done with provenance and a bounded response size.
42. **F2 · Decision register — P1.** Promote an explicit decision from conversation into a source-backed record. Done when a suggestion cannot silently become policy.
43. **F3 · Context-change explanation — P1.** Show what changed since an attempt started. Done when relevant corrections can invalidate affected work without restarting unrelated work.
44. **F4 · Result differences — P1.** Compare native result versions clearly. Done when reviewers see changed bytes and previous approval never transfers automatically.
45. **F5 · Attachments and previews — P2.** Extend beyond native text with size/type/permission boundaries. Done when uploaded content cannot execute inside the room service.
46. **F6 · Source refresh and contradictions — P2.** Track stale or conflicting references. Done when uncertainty is visible and an agent cannot silently overwrite a disputed fact.
47. **F7 · Reusable work recipes — P1.** Extend existing reuse into concise outcome/criteria templates. Done when copying a recipe does not copy old grants, private content or approvals.
48. **F8 · Export and deletion semantics — P1.** Define what can be exported, retained or removed. Done when owners understand the limits and privacy-sensitive derivatives are accounted for.

### G. Bring Dasha and execution into rooms — P2

49. **G1 · Attempt contract.** Record input version, performer, environment, limits and output references. Done with one work model and multiple attributable attempts.
50. **G2 · Deterministic fake runner.** Simulate start, output, failure, timeout and restart. Done before any paid/provider execution is required.
51. **G3 · Dispatch reconciliation.** Persist intent and reconcile uncertain external outcomes. Done when a lost response cannot cause duplicate execution.
52. **G4 · Isolated write environments.** Add a selected repository/ref and controlled per-attempt workspace. Done with explicit isolation guarantees; folders alone are not secret isolation.
53. **G5 · Dasha adapter contract.** Agree interfaces with Dasha's owners without editing their lanes. Done when Room remains responsible for work and Dasha reports execution evidence.
54. **G6 · Output and usage receipts.** Link exact outputs and measured usage separately from estimates. Done when unknown cost or missing artifacts cannot become a success claim.
55. **G7 · Meaningful cancellation.** Distinguish stop requested, dispatch disabled, access revoked and runtime stopped. Done when the UI never infers process termination from silence.
56. **G8 · Room-native development demonstration.** Build and review a bounded Dasha change through a Room workflow. Done with original work and owner decision retained; publication remains separate.

### H. Optional automation without an intimidating builder — P2

57. **H1 · Start with three recipes.** Draft catch-up, suggest next work, and request a review. Done when each has explicit triggers and produces a bounded useful outcome.
58. **H2 · Separate observe/draft/act.** Make permissions distinct. Done when enabling a reminder cannot send messages or launch paid work.
59. **H3 · Durable wake queue.** Add retry, coalescing and dead-letter/recovery behavior. Done when a restart preserves intent without duplicate action.
60. **H4 · Quiet hours and digest choice.** Let the operator control when attention is delivered. Done without changing canonical work or pretending delivery means handled.
61. **H5 · Real budget enforcement.** Bound runtime, attempts, concurrency and spend where supported. Done when unknown quota is labeled unknown and cannot authorize overage.
62. **H6 · Dry-run preview.** Show what a recipe would read or do before enabling it. Done when preview itself has no external effects.
63. **H7 · Pause and inspect.** One clear stop surface with readable recent outcomes. Done when pending and already-running attempts are distinguished.
64. **H8 · Hosted helper pilot.** Add a small optional agent only after cost/stop/authority tests. Done when the free manual/BYO path remains useful after its allowance ends.

### I. Bounties and contribution routes — P2

65. **I1 · Add reward to existing work.** Reuse the current task/result/review loop. Done without creating a disconnected bounty task database.
66. **I2 · Versioned reward agreement.** Capture amount, eligibility, criteria, review window and cancellation terms. Done when contributors explicitly accept changed terms.
67. **I3 · Reservation versus competition.** Make exclusive work and open submissions distinct choices. Done when someone can tell whether payment is guaranteed, conditional or competitive before starting.
68. **I4 · All contribution routes.** Support people, in-room agents, external tools, copied briefs and repository results. Done when every route returns to the same work record.
69. **I5 · Fair revision loop.** Show what failed, the exact affected result and what needs changing. Done when sponsors cannot silently expand scope after submission.
70. **I6 · Shared rewards.** Design explicit allocations for helpers/reviewers and partial work. Done with agreed splits and disagreement handling before money moves.
71. **I7 · Review-capacity controls.** Limit low-quality submission floods and expose queue expectations. Done without equating rate limits or model judgments with proven fairness.
72. **I8 · Private opportunity pilot.** Seed a few real, well-scoped tasks with responsive sponsors. Done when useful outputs and contributor experience are observed before a public board expands.

### J. Fiat and stablecoin payment readiness — P2, externally gated

73. **J1 · Confirm account eligibility.** Check actual Connect and stablecoin capabilities with approval. Done with account-specific evidence, not US registration alone.
74. **J2 · Choose the business/payment model.** Resolve customer relationship, fees, negative balance liability and payout timing. Done through explicit owner decisions and compatibility review.
75. **J3 · Separate money state.** Define funding, release authorization, transfer, payout, refund and dispute records. Done when work acceptance cannot fabricate a paid balance.
76. **J4 · Contributor onboarding.** Provide identity, payout-readiness and remediation flows. Done when agent identity is separate from the eligible person/entity receiving money.
77. **J5 · Reconcile provider events.** Verify and deduplicate events and read back authoritative state. Done in test mode with delayed, duplicated and reordered events.
78. **J6 · Refunds, disputes and reserves.** Define operational ownership and test failure paths. Done before claiming delivery-gated payouts are risk-free or calling them escrow.
79. **J7 · Currency/network clarity.** Show funded amount, expected recipient amount, fees and actual rail. Done without treating stablecoin acceptance as automatic payout support.
80. **J8 · Compliance and live-money gate.** Obtain relevant legal/tax/payment review and explicit pilot limits. Done before any real-money test or guaranteed earnings claim.

### K. Small online tasks, physical tasks and work trade — P3

81. **K1 · Small digital-help template.** Cover research, writing, checking data and testing an interface. Done with inspectable deliverables, not mandatory GitHub artifacts.
82. **K2 · Ask a human.** Let an agent propose a bounded question needing human context or judgment. Done when solicitation and payment require the appropriate consent.
83. **K3 · Two-sided work exchange.** Link two agreed deliverables without a money-like credit balance. Done when either side can see acceptance and cancellation conditions.
84. **K4 · Physical-task eligibility.** Define supported low-risk categories, participant requirements and prohibited tasks. Done after legal/safety/support review, before public listings.
85. **K5 · Private logistics.** Reveal address and schedule only to the right participant at the right stage. Done when public briefs and exported packets exclude sensitive location data.
86. **K6 · Evidence suited to the task.** Support explicit human confirmation and appropriate proof formats. Done without mandatory continuous location tracking or raw personal recordings.
87. **K7 · No-show and scope-change handling.** Specify cancellation, lateness, expenses and incident escalation. Done through realistic tabletop scenarios before physical-task launch.
88. **K8 · Test reciprocity demand.** Determine whether people want bilateral exchanges or a community credit system. Done through later authorized observation, not by issuing tokens first.

### L. Useful free experience, retention and organic growth — P1/P3

89. **L1 · Free-path promise — P1.** Document usable manual/BYO features and honest limits. Done when reaching a hosted-AI allowance does not block reading or continuing existing work.
90. **L2 · First-result onboarding — P1.** Let a newcomer join, contribute and see an outcome before advanced setup. Done in a complete simulated journey; human comprehension remains a later gate.
91. **L3 · Invite for a purpose — P1.** Deep-link a participant to the question or result they were invited to help with. Done without exporting the rest of the private room.
92. **L4 · Share a result, not a room — P3.** Build an explicit audience-previewed share flow. Done when private source rights and revocation limitations are clear.
93. **L5 · Reusable success templates — P1.** Let a useful completed workflow become a clean starting point. Done with fresh ownership and no copied confidential history.
94. **L6 · Evidence-based contributor profiles — P3.** Show opted-in accepted outputs and role attribution. Done without a fabricated universal quality score or pay-to-rank trust.
95. **L7 · Saved interests and opportunities — P3.** Match opted-in humans/agents to relevant public work. Done with frequency limits and no unsolicited private-room entry.
96. **L8 · Transparent hosted upgrade — P3.** Offer paid convenience only after measuring cost and value. Done with explicit limits, cancellation and no hidden automatic overage.

### M. Test, simplify and operate the code — P0/P1

97. **M1 · Journey coverage map — P0.** Link every claimed capability to unit, integration, browser, actual-agent and hosted evidence. Done when test count cannot conceal an untested user path.
98. **M2 · Shared domain-contract audit — P1.** Find duplicated rules across server, client, CLI and MCP. Done with a justified consolidation plan and preserved independent validation boundaries.
99. **M3 · State-machine review — P1.** Enumerate impossible combinations and transition invariants. Done when harmless randomized event sequences preserve them across replay.
100. **M4 · Performance budgets — P1.** Measure response bytes, redundant reads, tool errors and long-room latency. Done with before/after fixtures, not only a line-count reduction.
101. **M5 · Capacity and retention policy — P0.** Review room limits, request caps and large histories. Done when terminal/recovery actions remain available at capacity and limits are documented.
102. **M6 · Safe diagnostics — P1.** Add bounded operation IDs, error categories and support exports. Done without credentials, private reasoning or unnecessary room bodies in logs.
103. **M7 · Maintenance simplification — P1.** Audit dead code, fixture duplication, stale docs and module boundaries. Done when each deletion preserves intended behavior and regression coverage.
104. **M8 · Release evidence automation — P0.** Generate a compact manifest/check summary from actual results. Done when skipped tests, dirty candidates and unverified live state cannot be labeled passed/live.

### N. High-value experiments before major commitments — P3

105. **N1 · Solo versus coordinated pair.** Compare original output quality under the same resource ceiling. Done with blinded criteria and no assumption that two agents win.
106. **N2 · Review value, not review volume.** Compare reviewer findings against known benign correctness defects. Done when useful detection and false alarms are distinct from comments posted.
107. **N3 · The zero-forwarding test.** Give a new agent only Room access and a bounded task. Done when it retrieves context, asks a question and hands off without operator relays.
108. **N4 · Context package experiment.** Compare selected structured context with a larger transcript. Done with quality, omissions and response-size evidence, not a blanket smaller-is-better rule.
109. **N5 · Connection friction trial.** Compare guided local setup, remote setup when available and manual handoff. Done with actual setup/failure observations rather than vendor-document compatibility.
110. **N6 · Help exchange versus reward.** Test demand for a small reciprocal task and a sponsored task. Done only with explicit participation/payment authority and no invented demand figures.
111. **N7 · Result-first return screen.** Compare finding the next decision from a compact result view versus a raw activity view. Simulate now; confirm comprehension with authorized humans later.
112. **N8 · Marketplace go/no-go.** Decide whether available sponsors, reviewers and suitable work justify public discovery. Done with real pilot evidence and a plan for moderation/support, not listing volume alone.

## 7. What not to build yet

- A general visual automation canvas before a few small recipes prove useful.
- Autonomous agent hiring/spending or universal cross-room authority.
- A separate chat, agent, bounty and compute task database for the same work.
- A token economy, fungible agent-hours or a universal reputation leaderboard.
- Always-on agent narration, obligatory daily activity or automatic message chains.
- Mandatory raw transcript uploads to prove contribution.
- A full Mercor-style recruitment/interview operation before demand requires it.
- Public physical-task listings without operational and safety support.
- A vendor logo marked connected because configuration instructions exist.
- Another architecture rewrite to make the plan feel newer.

## 8. The next concrete build brief

Select A1–A8 as one vertical slice, with B1/M1/M104 as the documentation/evidence
lane. Keep the ordinary composer and navigation. Design draft ownership and
uncertain-write recovery before adding buttons. Review the new attention-format
contract before writing migration code. Then run independent actual-agent
clarification/resume and simulated-human screenshot journeys.

After that checkpoint, prioritize the release-recovery gate and two real native
host tests over another new feature family. Revisit the remainder using observed
friction. This maintains momentum without turning the roadmap into a permanent
substitute for a usable released product.

## 9. Evidence to gather as we go

Record completed useful journeys, operator relays, unresolved questions, duplicate
work, wrong-scope refusals, reviewer findings, interrupted-work recovery and source
versions. Measure agent response bytes and runtime cost where genuinely available.
These are experiment observations, not a finalized analytics/KPI program. A future
measurement-design task should define denominators, consent and retention before
collecting production behavior. Do not infer enjoyment, retention or market demand
from passing browser tests or model-generated personas.

When evidence is weak, label a decision provisional. When a capability is local,
label it local. When a task is finished, record the exact result and its remaining
release gates. That discipline is part of the experience we are trying to offer
both humans and agents.
