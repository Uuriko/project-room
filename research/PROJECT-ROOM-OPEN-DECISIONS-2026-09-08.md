# Project Room: unanswered questions and consequential choices

September 8, 2026. Research-only decision register. No implementation, deployment or provider access performed.

## What this adds

The [inspiration atlas](PROJECT-ROOM-INSPIRATION-ATLAS-2026-09-08.md) asks what we could borrow. This document asks what must be true for those ideas to produce a good product. It contains twelve researched choices and twenty-four additional questions. Recommendations are provisional design judgments, not findings that Project Room has already been tested against.

Evidence includes peer-reviewed human–AI research, current agent-system papers, official protocol and synchronization documentation, and established interaction-design guidance. Academic experiments are not direct forecasts of our product. Several papers were reviewed through abstracts and selected sections, not reproduced; the agent-cooperation paper's environment and interventions were inspected in more detail. Protocol documentation is version-sensitive. No recommendation below establishes payment compliance, production readiness or measured retention.

## Twelve researched choices

### 1. Should every task become a team of agents?

**Evidence.** The April 2026 revision of *Towards a Science of Scaling Agent Systems* evaluates 260 configurations across six benchmarks. It reports that task structure matters: coordination can help decomposable work and hurt sequential work. Search snippets still exposed older figures, so this review uses the revised paper's qualitative conclusion rather than treating an earlier threshold as a universal rule. [Paper, v3](https://arxiv.org/abs/2512.08296v3).

**Choice:** one accountable worker by default; add specialists for independently useful subtasks or genuinely independent review. The product can be multiplayer without making every operation multi-agent.

**Unresolved:** who decides whether a task is decomposable, and can the owner understand that decision? Compare a single worker, worker-plus-reviewer and parallel specialists on the same representative work before selecting a default.

### 2. What actually encourages agents to help one another?

**Evidence.** *More Capable, Less Cooperative?* studies a deliberately simplified environment with costless information sharing. Explicit protocols and small sharing incentives helped different failure modes; stronger capability did not reliably imply better cooperation. This is evidence about the tested setup, not proof that production agents require cash rewards. [Paper and experimental design](https://arxiv.org/html/2604.07821v2).

**Choice:** make helping legible: explicit requests, acknowledgments, useful handoffs and attribution for unblocking work. State the shared objective alongside each participant's assignment. Avoid a default leaderboard ranking agents by individual task count.

**Unresolved:** how do we distinguish useful assistance from manufactured dependencies or message spam? Start with accepted contributions linked to an outcome, not points for activity.

### 3. Does human review improve quality, or merely add a button?

**Evidence.** A 2024 meta-analysis of 106 studies found human–AI combinations improved on humans alone on average, but not on the better of the human-only and AI-only alternatives. Its studies predate current agent products. Separately, a 199-participant study found cognitive-forcing interventions reduced overreliance but were less favorably rated. Neither establishes that every action should require more review. [Meta-analysis](https://www.nature.com/articles/s41562-024-02024-1), [review-friction study](https://arxiv.org/abs/2102.09692).

**Choice:** separate authorization from quality checking. Show the changed material, relevant evidence and unresolved issues when review matters. Avoid presenting an elegant explanation as proof of correctness.

**Unresolved:** when does review become habitual approval? Test whether a reviewer notices a deliberately incorrect artifact in a safe fixture, not just whether they click Approve. Human simulations can reveal design problems but cannot establish actual human error-detection rates.

### 4. What does “done” mean?

**Evidence.** The MAST research identifies failures involving system design, inter-agent misalignment and task verification. A2A distinguishes terminal execution states and leaves artifact-version linkage to the client. These are reminders that successful execution and an accepted deliverable are different concepts. [MAST](https://arxiv.org/abs/2503.13657v3), [A2A task lifecycle, development documentation](https://a2a-protocol.org/dev/topics/life-of-a-task/).

**Choice:** distinguish worker finished, result submitted, result accepted and any subsequent external action. A room owner can reopen work without pretending the original execution never finished. Preserve the relationship between attempts and artifacts.

**Unresolved:** who may accept a result when the requester disappears? Name a reviewer and escalation policy at assignment time for consequential work; do not infer acceptance from silence.

### 5. Can we honestly promise “Stop”?

**Evidence.** Current MCP Tasks documentation says cancellation is cooperative; acknowledging a request does not guarantee work stops. Client support also varies. [MCP Tasks](https://modelcontextprotocol.io/extensions/tasks/overview).

**Choice:** model stopping requested, stopped and already completed distinctly. Revocation should prevent new authorized actions under our control, while the UI reports any external action already in flight. Never imply that cancelling a local task retracts a sent message.

**Unresolved:** which providers give definitive cancellation, and which only best effort? Maintain that distinction per adapter and test with harmless delayed fixtures. A protocol acknowledgement is not proof of stopped compute or reversed effects.

### 6. Should MCP or A2A define our internal product model?

**Evidence.** MCP Tasks exposes asynchronous task handles through a negotiated extension. A2A separates messages, tasks and artifacts, including terminal-state semantics. Neither supplies all room ownership, acceptance or cross-channel product rules. [MCP extension](https://modelcontextprotocol.io/extensions/tasks/overview), [A2A specification](https://a2a-protocol.org/latest/specification/).

**Choice:** retain one internal work model and expose adapters for supported protocol versions. Keep a basic API and manual contribution route available when a client lacks an extension. Do not label a provider fully connected because one tool call succeeds.

**Unresolved:** what minimum interoperability promise can we test? A candidate is discover permitted work, accept a bounded assignment, report progress, submit an artifact and recover after disconnect. Each capability needs an explicit compatibility result.

### 7. When should an agent ask instead of act?

**Evidence.** Microsoft's HAX guidance recommends clarification or reduced scope when the user's goal is uncertain. Its examples concern ambiguity in intended action, not a claim that model-generated confidence is reliably calibrated. [Scope services when in doubt](https://www.microsoft.com/en-us/haxtoolkit/guideline/scope-services-when-in-doubt/).

**Choice:** allow reversible preparation within a grant; ask when missing information changes recipients, public visibility, commitments or cost. A room invitation is not unrestricted authority to use every connected account.

**Unresolved:** how can we avoid both interruption overload and silent assumptions? Separate harmless defaults from consequential choices; record the assumptions used in a draft without turning each into a modal dialog.

### 8. How fresh and complete is an agent's picture of a room?

**Evidence.** Gmail's official synchronization guide documents expiring history ranges and the need for full synchronization when history is unavailable. A connected account therefore does not by itself prove complete or current context. [Synchronization guide](https://developers.google.com/workspace/gmail/api/guides/sync).

**Choice:** distinguish connection health, synchronization freshness and source completeness. Tie prepared work to the source versions it used. If relevant input changes, flag or revalidate the draft rather than silently treating it as current.

**Unresolved:** how much history is enough for each task? “All available messages” is not always necessary or desirable. Test bounded context packets against a fuller authorized baseline and inspect what important information was omitted.

### 9. Who owns shared information after organizations separate?

**Evidence.** Slack Connect applies organizations' retention settings to their own members' contributions, with documented exceptions. This demonstrates that cross-organization retention is not naturally one global room setting. It does not prescribe our policy. [Slack's data-management rules](https://slack.com/help/articles/115004152843-How-data-management-features-apply-to-Slack-Connect).

**Choice:** distinguish the source owner, room audience and accepted artifact owner. Clearly separate disconnecting a source, removing access and deleting a retained copy. Do not promise deletion from recipients' external systems.

**Unresolved:** which derived summaries must be removed or regenerated when their source is removed? We need an explicit retention policy and dependency model before broad external collaboration. Legal obligations require separate review; this is a product-design question register, not legal advice.

### 10. When does minimal design become invisible functionality?

**Evidence.** NN/g's progressive-disclosure guidance distinguishes common actions from advanced options; its recognition guidance cautions against forcing people to remember hidden meanings. Less visible text alone does not establish easier use. [Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/), [recognition and recall](https://www.nngroup.com/articles/recognition-and-recall/).

**Choice:** keep common actions and important state recognizable. Use contextual controls for advanced options and short labels when icons are ambiguous. Avoid silently rearranging navigation as someone becomes more experienced.

**Unresolved:** which controls are genuinely self-explanatory? Compare compact labels with icon-only alternatives during tasks; do not assume a beautiful screenshot proves discoverability.

### 11. Which events deserve a person's attention?

**Evidence.** A notification-interruption experiment used a one-day intervention and self-reported outcomes in a mixed employee/student sample. Disabling notifications reduced reported interruption frequency; its scope does not justify one universal notification schedule for a work product. [Study and methods](https://pmc.ncbi.nlm.nih.gov/articles/PMC10244611/).

**Choice:** separate immediate requests requiring a person from ordinary progress, which can be grouped. Preserve a visible place to catch up. Do not notify everyone merely because an agent generated another update.

**Unresolved:** how do we prevent a quiet interface from concealing blocked work? Let responsibility and deadlines drive escalation. Notification settings should be understandable and reversible, not depend on opaque engagement predictions.

### 12. How do we evolve helpers without breaking a room's habits?

**Evidence.** Google's technical-debt research highlights data dependencies, hidden consumers and feedback loops as system-level costs in ML applications. It is an older architectural warning, not an agent-specific benchmark. [Research paper overview](https://research.google/pubs/machine-learning-the-high-interest-credit-card-of-technical-debt/).

**Choice:** version helper configuration, tools and relevant context sources. Recheck representative work before promoting a material change. A changed model should not silently gain different permissions or be assumed to preserve behavior.

**Unresolved:** what constitutes a meaningful change to the user? Surface changes in capability, behavior and authority; keep ordinary technical version details in an inspectable record.

## Twenty-four further questions

These are newly sharpened hypotheses and research tasks, not settled by the evidence above. They are grouped to avoid turning every question into another feature.

### Product focus and first value

13. What is the first useful result for a person who has not invited anyone or connected an account? Try a small request with a manually attached source before requiring setup.
14. Are recurring teams or temporary project groups the better initial audience? Compare their real work patterns before committing to organizational complexity.
15. Should a room represent a goal, a team or an external conversation? Prefer a goal as the working hypothesis; allow links to people and conversations rather than treating these as identical.
16. When should a successful room close? Explore an explicit completed state with reusable results, rather than measuring success through perpetual activity.

### Delegation and authority

17. What happens when a person and their personal agent disagree in the same room? Make delegation explicit; do not assume every agent utterance is its owner's instruction.
18. May a helper hire or spawn another helper? Require delegation limits that cover both authority and resource use; inheriting context should not automatically inherit all permissions.
19. Can a task move between agents owned by different organizations? Define the minimum transferable context and what private execution material stays behind.
20. If a worker loses access halfway through, can its partially completed result still be reviewed? Separate receiving a submission from authorizing continued source access.

### Contribution quality and fairness

21. Can two people contribute useful alternatives without racing for one reward? Consider declared exploratory work versus exclusive execution assignments.
22. Who receives credit when one participant supplies the crucial clue and another finishes the artifact? Make attribution reviewable and connected to evidence.
23. How can a new contributor earn trust without an existing reputation? Start with small, scoped opportunities and specific acceptance criteria, not a single global score.
24. What happens when requested work changes after someone starts? Preserve the original scope and explicitly agree on a revision; changing a description should not erase prior expectations.

### Rewards and free use

25. What precisely is rewarded: time, accepted milestones, final outputs or useful assistance? Different work needs different contracts; do not silently combine them.
26. Who bears the cost of rejected work or a cancelled request? Resolve this before accepting paid assignments, not through a surprise default after submission.
27. What remains genuinely useful when hosted AI usage is exhausted? Keep manual collaboration, access to one's results and compatible bring-your-own-agent paths usable within stated service limits.
28. Can reciprocal help work without transferable credits? Test explicit two-sided promises first. Credit systems, cash collection and stablecoin distribution need separate operational and legal work; this pass does not approve a payment model.

### Privacy, memory and portability

29. Can someone share an excerpt without revealing its surrounding private thread? Make the preview match the actual audience-visible material.
30. What should an agent forget when it leaves a room? Define what we can revoke or delete locally versus what an external provider may already have received.
31. Which accepted results can survive removal of their source? Separate durable deliverables from source-dependent summaries and record their lineage.
32. What can a user export to continue elsewhere? Consider messages, accepted artifacts, decisions and work history—not only a transcript stripped of context.

### Adoption and operational survival

33. Which artifact is worth sharing outside a room without exposing private work? Test a deliberately prepared public example rather than automatically publishing a room.
34. Can a new participant contribute without understanding the entire product? Try a single scoped invitation with context, one expected action and a return path.
35. If a messaging provider is unavailable, what work can continue? Preserve local drafts and review; visibly separate unavailable external actions from ordinary room use.
36. Who can recover a room when its sole owner disappears? Establish administrator succession and stalled-work handling before expanding to consequential external work.

## What to settle next

The highest-leverage next step is a small work contract, not another dashboard. Define the goal, owner, reviewer, permitted sources, expected artifact and authority boundary in a way that remains mostly invisible during ordinary use. Then exercise five cases:

1. A person brings in a source and gets a useful reviewed result without elaborate setup.
2. Two agents choose overlapping work; the room produces a clean handoff or deliberate comparison, not duplicate execution.
3. A source changes after a draft is prepared; the change is visible before the draft is used.
4. Cancellation arrives while an external operation is pending; the interface reports what actually stopped and what remains uncertain.
5. A reviewer encounters a plausible but incorrect result; the design makes checking it practical.

These are proposed tests, not tests run during this research. Use local fixtures and authorized agent participants first. Real human behavior still requires consenting human participants; simulation is useful for finding issues, not proving retention, comprehension or trust.

Decide now: explicit ownership, separate execution from acceptance, capability-aware integrations, reversible preparation and honest state. Validate rather than assume: default team size, review design, first-use experience, notifications and contribution incentives. Defer until separately resolved: broad public rewards, transferable credits, unrestricted delegation and claims of universal messaging support.

The key shift is from “How many things can a room do?” to “Can a person or agent understand what is expected, make a useful contribution and trust what happens next?”
