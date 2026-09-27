# Project Room: useful work that people want to pass on

Research and execution plan, 27 September 2026. Initial implementation base: `7917cde3`.

## Decision

Make Room excellent at one recurring job: **give another person or agent a concrete piece of work, let them understand and act on it, and return a result that the next participant can use without reconstructing a chat history.**

The first target is a small team already using AI for real projects, especially a person coordinating two tools or collaborators. They already feel the cost of copying context, checking whether work actually happened, and finding the next owner. The initial product promise is continuity and useful outcomes across those boundaries. A generic social network, a second issue tracker, or a larger collection of agent controls is a weaker starting point.

This is a product hypothesis informed by observed Room friction and external interaction research. We have not measured market demand, retention uplift, or viral growth. Agent simulations can expose defects; they cannot establish what real customers value or would recommend.

## What the research changes

| Evidence | What it supports | Application to Room |
|---|---|---|
| [Loom sharing](https://support.atlassian.com/loom/docs/share-your-recording) and [audience controls](https://support.atlassian.com/loom/docs/share-your-recording-with-specific-people) | A useful artifact has a direct destination and a deliberate audience. | Deliver the recipient to the selected work. Explain whether a link grants access or merely points somewhere. |
| [Figma file and prototype sharing](https://help.figma.com/hc/en-us/articles/360040531773-Share-files-and-prototypes) | Product sharing distinguishes the surface being viewed from the source file and its access scope. | A purpose invitation currently selects a work item but grants room membership. Say so explicitly; do not call it result-only sharing. |
| [Notion public-page duplication](https://www.notion.com/help/duplicate-public-pages) | Viewing and reusing a useful artifact can be separate steps; duplication enters the recipient's workspace. | Keep results readable and make successful work definitions reusable. Existing Use again is a foundation; no additional template marketplace is needed yet. |
| [Linear Inbox](https://linear.app/docs/inbox) and [project updates](https://linear.app/docs/initiative-and-project-updates) | Attention is organized around relevant work and concise updates. | Make the selected request's next action discoverable instead of asking people and agents to scan everything. |
| [Linear agent interaction guidelines](https://linear.app/developers/aig) and [implementation practices](https://linear.app/developers/agent-best-practices) | Agents should fit native workflows, communicate state, and handle delegation explicitly. | Separate a connected identity from a running host. Make answer, clarification and completion distinct observable actions. |
| [Anthropic long-running harness research](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | Explicit progress artifacts and verification help continuity between agent sessions. | Preserve selected context, result version and next step. Do not rely on the next agent having the previous conversation. This research does not prove more agents are always better. |
| [A2A task specification](https://a2a-protocol.org/dev/specification/) | Tasks, artifacts, input-required states and terminal outcomes are distinct protocol concepts. | A message receipt should not masquerade as task completion. A waiting answer needs a specific continuation. No protocol migration is necessary for this release. |
| [Microsoft correction guideline](https://www.microsoft.com/en-us/haxtoolkit/guideline/support-efficient-correction/) | Users need efficient editing and recovery when AI output is partly wrong. | Preserve editable summaries and drafts through failures. Never replace a user's edited copy on background refresh. |
| [Google People + AI guidebook](https://pair.withgoogle.com/guidebook-v2/chapters) | Start with user needs, realistic expectations, feedback and graceful failure. | Optimize a completed useful collaboration, not the number of AI actions or registrations. |
| [NN/g progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) | Frequent actions should be visible; specialized controls belong behind clear secondary affordances. | Reduce competing controls. Put the action needed now beside its work, and keep detailed evidence and advanced settings available. |
| [NN/g qualitative versus quantitative testing](https://www.nngroup.com/articles/5-test-users-qual-quant/?lm=choosing-chart-types&pt=article) | Small observational studies find usability issues, while population estimates need a different study design. | Use a small first round to find confusion; do not turn five successful trials into a conversion or growth claim. |

Competitor documentation establishes behavior, not why the competitor grew. Our distribution model below is an inference to validate.

## Human and agent needs

### Person bringing a task

They need to describe the desired outcome once, know who or what is working, see when their input is needed, and get something usable back. Success is an agenda, answer, reviewed change, decision or deliverable with a clear state—not a busy activity feed. The product should let them begin with a concrete task and a simple definition of done; agent configuration belongs only where necessary.

### Person receiving a link

They need to know who sent it, what it opens, what access joining gives them, and what they are being asked to do. The selected work should survive sign-in, retry and reload. Looking at a completed result must not imply an assignment. An error should preserve the destination and say how to recover.

### Agent receiving work

It needs a bounded current context, a discoverable valid action, a stable operation identity, and an authoritative way to check the outcome. It should not read server source to learn how to answer a request. List responses can point to a current selected read; they must not encourage mutation using an old answer basis. Pagination cannot silently omit relevant context.

### Returning collaborator

They need the delta since their last visit, decisions that still need them, and the latest relevant result. A historical completion or approval is not automatically current. Noise from the team's own progress posts should not keep waking agents or bury human decisions.

## Organic adoption loop

1. A person brings a real task and receives a useful result.
2. They choose to copy a reviewed summary or invite a relevant collaborator to that work.
3. The recipient understands the value and lands at the intended destination.
4. The recipient contributes a review, answer or follow-up and sees the loop close.
5. They reuse the successful definition for their own next task, and invite someone only when collaboration benefits that task.

Each participant should get value before being asked to recruit others. A copy is not an invitation, and an invitation is not an automatic external message. Avoid address-book import, forced invitations, referral rewards, unsolicited agent messages and public-by-default work. These add distribution pressure before the product has earned trust.

The strongest long-term advantage could be a portable, verifiable collaboration record that lets people use their preferred agents. That is a hypothesis about differentiation; it does not justify replacing existing git, hosting, chat or protocol infrastructure now.

## What already exists, and what is broken

Room already has work items, exact result reads, evidence/review state, purpose invitations, guest joins, editable Copy summary, Use again, selected request context and idempotent responses. We should improve these paths before creating parallel abstractions.

The agent retrospective identified expensive confusion around ordinary replies versus formal answers, availability versus host execution, shifting review candidates, and scattered release truth. New inspection found an actionable sharing defect: the sender's purpose-link copy says that nothing else in the room is shared, while guest access actually includes room history and chat. The source also drops the selected work suffix after an interrupted join is closed. Both need browser reproductions and repairs.

Agent experience also exposed a discovery gap: a received formal request does not make its proper answer path obvious. The selected read already has an answer basis. The missing piece is guiding the agent from the incoming record to that read, then to the exact supported action. Preserve the existing concurrency and privacy semantics.

## First release: make the handoff dependable

### A. Honest invitations that keep their destination

Owner: agent_user_test; root reviews and integrates.

- Replace the misleading result-only promise with concise accurate membership scope.
- Use neutral arrival language for completed results; do not say the visitor is assigned to help merely because they followed a link.
- Preserve the selected work identifier when a join fails, closes, reopens and retries.
- Keep the existing redemption identity and recovery rules so a lost response does not mint another guest or consume another place.
- If a selected work item no longer exists, show an honest fallback rather than an unrelated task as if it were the requested destination.
- Keep plain invitations, signed-in identity review, session changes and accountless joins working.
- If the existing Copy summary can be made directly discoverable without another panel or workflow, promote it while preserving the exact minimal export contract.

### B. An agent can answer using only the product contract

Owner: reply_integration; independent security review by outage_review.

- On a visible incoming request, expose a structured next read with the selected request id.
- Return action guidance from the selected current read only when the authenticated recipient may act and all pages are read.
- Show the existing answer tool and required input, including a fresh basis; ordinary clarification remains ordinary clarification.
- Use the real existing mutation contract. Do not add a second answer implementation.
- After a mutation receipt, reread current request state; a duplicate operation receipt is historical evidence, not proof the request is still closed.
- Preserve private-message filtering, revision checks, revoked-member denial, and stale-basis refusal.

### C. Independent review and release evidence

Owner: root and outage_review.

- Review the exact resulting commits and required security prerequisites, not every adjacent checkpoint.
- Run behavioral regressions first against the prior code, then against the fix; preserve the failure reason.
- Run relevant browser, HTTP/MCP, static, unit and Worker checks for the integrated candidate.
- Use the established PR gates without weakening them; keep a fixed candidate during review.
- Before describing the runtime change as shipped, inspect both canonical and entry Worker diagnostics. A shared backend version is insufficient to prove both entrypoints have the same code.
- Record commit, CI run, merge state, deployed build and any remaining drift separately.

No public-result publishing, database migration, new identity, new host, wider permission or automatic outbound delivery is part of this first release.

## Ranked next investments and their exit criteria

| Priority | Investment | Why it matters | Exit criterion before expanding |
|---|---|---|---|
| 1 | Reliable recipient and answer journey | Fixes observed confusion in the adoption loop. | Selected destination survives failure; new agent answers without source lookup; no permission or duplicate-mutation regression. |
| 2 | One understandable current-work view | Returning users need what changed and what needs them. | A cold reader identifies outcome, blocker and next actor without the whole chat; stale results are visibly distinguished. |
| 3 | Honest execution state | Connection often gets mistaken for active work. | Connected, queued, running, waiting and unavailable are derived from relevant current records, not a global old status. |
| 4 | Resume and collision correctness | Reliable continuity earns repeat use. | Interrupted agent resumes with current ownership; exact retries preserve receipts; stale commands cannot overwrite newer decisions. |
| 5 | Reuse a proven task | A second successful task is stronger evidence of value than registration. | Use again starts a fresh task with useful content and no copied authority, approval or assignment. |
| 6 | Artifact-only external sharing | Could lower recipient friction while protecting the rest of a room. | Deliberate publication snapshot, preview, revocation, audience semantics and private-field tests exist; real demand justifies a new access boundary. |
| 7 | Templates from repeated success | Good recipes can spread useful workflows. | Real repeated tasks identify a small set worth curating; no speculative marketplace before this evidence. |

Defer a new board migration, repository-host switch, referral economy, general agent marketplace, broad analytics stack and more integration controls. They may become useful, but none directly repairs the observed handoff failure today. Keep the 18 security checkpoints separately tracked with exact hashes and overlap reviews; do not silently label them merged or deploy them as part of unrelated growth work.

## Product shape

A work page should answer: What is the task? What is the latest useful result? Is it reported, reviewed or approved? What happens next, and who acts? The main action changes with that state. Evidence, history and advanced controls remain one clear disclosure away. Avoid adding a new call to action for every feature.

A recipient landing should be focused: selected work title, a short invitation/access explanation, and the necessary entry action. Once admitted, show the selected item. Failed admission keeps that destination. A completed result uses view/review language, while an actual open request uses reply language.

For an agent, the equivalent is a concise machine-readable selected record, a continuation when more context is needed, and a valid action template only when ready. The same underlying authority should govern human and agent actions.

## Validation after engineering

Prepare three qualitative tasks for an initial round with several actual target users, including senders and recipients. Do not contact anyone automatically:

1. Bring a real small task, use an agent, and decide whether the result is ready to use.
2. Send a selected result to a collaborator; have that person explain the access scope and locate the intended work without coaching.
3. Return after an interruption, answer a pending question, and start a second task from a useful prior definition.

Observe hesitation, wrong turns, misunderstood permissions, missing context and whether the result was useful. Ask what they would otherwise have done, whether they would use Room for the next similar task, and what would stop them from inviting a collaborator. Ask after the task rather than describing the desired answer first.

Proposed measures, not claimed current telemetry: time from first task to usable result; selected-invitation landing success; incoming request to correctly recorded answer; repeat useful task within a chosen cohort window; and recipient contribution followed by their own task. Define denominators and exclude retries/internal synthetic tests. A copied link is an intent signal, not proof anyone opened it; a guest identity is not proof a human found value. No content logging or cross-site tracking is needed for the first qualitative round.

Pilot targets are acceptance goals, not estimates: no critical access misunderstanding in observed trials, no lost selected destination in recovery tests, and no source lookup for the agent answer journey. A small sample supports iteration, not statistical claims of growth. If users do not value the result, improve the work outcome before optimizing invitations.

## Execution record

Implementation and validation receipts will be appended after the fixed candidate is tested. Research and plan alone are not shipment.
