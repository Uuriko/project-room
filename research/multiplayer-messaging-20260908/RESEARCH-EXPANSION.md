# Project Room: research expansion and product opportunities

September 8, 2026. Working addendum to the Collaboration and Messaging Plan, not a replacement for its provider constraints or launch gates. This round reviewed additional primary product documentation, protocol guidance and research. Ideas below are proposals, not implemented features or measured growth claims. The earlier six-repository source review remains the code evidence; no new third-party code was executed this round.

## 1. The sharper product thesis

Project Room should be the place where a request becomes a useful result—with the right people, agents and tools involved—without making the user move everything into a new system.

The key loop is: bring something → get help → review the result → return it to its destination.

A universal inbox can support that loop, but it should not become a prerequisite. Someone should be able to paste a request, attach a file or bring a selected message before connecting any account. Full integrations make repeated use easier later. This changes the priority from “connect every channel” to “complete one valuable collaboration.”

Three boundaries keep this coherent:

- A message is not automatically a task. Conversation can stay lightweight until someone accepts work.
- A task is not automatically an agent run. Humans can do it, an external agent can contribute, or a connected worker can execute it.
- A finished run is not automatically an accepted result or successful external action. Review and delivery retain their own evidence.

## 2. What the new research changes

### Intake before commitment: Linear

Linear's Triage separates incoming issues from the team's normal workflow. It supports accepting, declining, identifying duplicates and snoozing. Its Customer Requests feature links feedback to issues or projects while retaining source references. These are documented product behaviors, not evidence that our proposed flow improves retention. [Triage](https://linear.app/docs/triage), [Customer Requests](https://linear.app/docs/customer-requests).

Our inference: allow a request to exist without immediately scheduling agents or filling a task board. Several authorized sources can support one work item, but similarity should suggest a link, not silently merge private contexts. A source reference must not confer source-account access. Do not copy Linear's workspace-wide customer visibility into a personal inbox.

### Attention follows intent: Zulip

Zulip lets people follow specific topics, filter for followed conversations and choose notification behavior. Optional automatic following can depend on participation or mentions; explicit muting remains meaningful. [Follow a topic](https://zulip.com/help/follow-a-topic).

Our inference: distinguish “unread” from “needs a decision.” An agent emitting ten progress updates should not create ten urgent items. Inbox can have a contextual Needs you filter for approvals, questions and failed handoffs. Keep ordinary messages available without treating all of them as obligations. Following work changes notifications, never permissions.

### Useful offline work, authoritative online commitments: local-first research

Kleppmann and colleagues' Onward! 2019 work argues for local responsiveness, offline work, collaboration and user control. It is a design/research argument, not a guarantee that a particular synchronization engine fits our application. Its scope explicitly distinguishes creative documents from services such as banking. [Paper and essay](https://www.inkandswitch.com/essay/local-first/).

Automerge's current documentation demonstrates local storage and synchronization across peers. Its public tutorial sync service is explicitly not a private production service. [Local storage](https://automerge.org/docs/tutorial/local-sync/), [Network synchronization](https://automerge.org/docs/tutorial/network-sync/).

Our inference: preserve drafts and explicitly permitted cached artifacts locally, but retain server authority for membership, work claims and external-send admission. An offline draft may be edited; an offline send must not be represented as accepted. Do not replace the existing event model with a CRDT merely to obtain a smoother composer. Evaluate collaborative document editing as an isolated future feature. Shared-device sign-out and retention rules must govern local caches; revocation cannot magically erase already exported copies.

### Decisions must survive an agent restart: LangGraph

LangGraph documents durable checkpoints and interrupts that wait for external input. Resumption restarts the interrupted node from its beginning, so preceding side effects can repeat. Its documentation recommends idempotent effects or separating them from interrupt logic. [Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts).

Our inference: Project Room owns the decision record, not a transient agent chat. A decision identifies the requester, permitted approver, exact proposal version, expiration and current state. An approval can survive a worker restart, but resumption must recheck current authority and must not replay a completed send. We can borrow these semantics without adding LangGraph as a mandatory runtime.

### Collaborate without forcing every participant into our runtime: A2A

A2A's task lifecycle distinguishes lightweight messages from tracked work. Terminal tasks cannot restart; refinements create new tasks in a related context. Artifact-version linkage is left to the client rather than solved universally by the protocol. [Life of a task](https://a2a-protocol.org/latest/topics/life-of-a-task/).

Our inference: Project Room should own accepted artifact versions and map external task/run IDs onto its work model. A remote agent saying completed means that remote execution ended; it does not prove human acceptance. Protocol support is an adapter capability, not a new user-facing product section. Do not reopen a terminal external task by pretending the protocol supports it.

### Bring approvals to a familiar place, carefully: n8n

n8n's Gmail node documentation describes sending an approval request and waiting for the recipient, and using the service for human review of AI tool calls. [Gmail message operations](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.gmail/message-operations/).

Our inference: later, a person could receive a minimal “Project Room needs your decision” notification in a chosen channel. Initially the notification should link to authenticated review in Project Room rather than treat an emailed approval link as sufficient identity. Notification content itself must obey privacy grants. This is optional convenience after in-room review works, not a reason to expose private drafts in notifications.

### Research lead: workflow quality beyond prompts

Tang, Zhou and Chen's July 2026 preprint analyzes 6,003 public n8n workflow designs and describes limited explicit fallback and review mechanisms. This round reviewed the abstract, introductory scope and methodology framing, not the complete paper. It explicitly distinguishes static workflow JSON from runtime behavior. The sample is public workflow designs, not a representative measurement of production incidents. [Preprint v2](https://arxiv.org/html/2606.29116v2).

Use it as motivation to test recovery and human control, not as proof that competitors are unsafe or that our approach is more successful. A follow-up full-methodology review is needed before using its detailed quantitative findings in product claims.

## 3. Brainstorm: 24 possibilities, not 24 commitments

### Immediate usefulness

1. Bring anything: paste text, attach a document or add a link to start working without account setup. Clearly distinguish pasted material from a verified live source.
2. A private preparation area: organize a request and choose excerpts before sharing it with a room. Reuse draft state rather than adding a new navigation destination.
3. Turn a selected source into work: one contextual action opens the smallest necessary scope and acceptance fields.
4. Return a result anywhere: copy or download first; connected sending when qualified. “Copied” is never labeled “sent.”
5. A current-result card: keep the latest accepted deliverable visible above the history, with the source and prior versions available on demand.
6. Continue where I stopped: preserve the room, selected artifact, composer and scroll position across navigation and reconnect.

### Agents that cooperate with less friction

7. A compact orientation packet: objective, current accepted artifact, explicit constraints, active owner, open question and allowed operations. Avoid replaying the full transcript by default.
8. A versioned external-work packet: an authorized user can copy a prompt or download a bundle for another AI tool. Include a work reference and structured return format, never embedded room credentials.
9. A contribution return slot: paste or upload the result against the original work reference. Mark manually returned work as unverified external contribution until reviewed.
10. Alternatives beside ownership: one worker owns the accepted task while other permitted participants can offer a different draft or bounded review.
11. A request for specific help: “Need a design review” or “Need a source check,” linked to the exact artifact revision, instead of broadcasting the entire project.
12. Resume with another agent: transfer the approved work state and evidence, not hidden reasoning or a promise of identical continuation. Explicitly stop/release the old claim where possible; a disconnected worker may still be running elsewhere.

### Human control that feels like normal collaboration

13. A decision card: show the proposed change or reply, relevant source, audience and cost when applicable, plus Edit, Approve and Decline. Not a generic permission dialog.
14. A real question state: an agent asks one focused question and waits, preserving the answer against the relevant proposal rather than scattering it through chat.
15. Safe draft comparison: show two alternatives without overwriting the human's current draft; accepting one creates a new revision.
16. A concise completion receipt: what changed, which version was accepted and which external action actually succeeded. More detail stays behind the card.
17. Explain the unavailable action: “Connect email to send” or “Waiting for owner,” with the next valid action rather than a disabled unexplained button.
18. Review packets: batch related low-risk proposals for reading, while requiring explicit selection of the items being approved. Never a catch-all approval for unrelated future actions.

### Useful return visits and voluntary sharing

19. Needs you: decisions, questions and actionable failures in one filter; an ordinary unread message does not count as pending work.
20. Follow this outcome: subscribe to accepted results or blockers, not every intermediate tool call. Explicit mute wins.
21. A return brief: on request, show what changed since the last visit, with links to authorized evidence. Deterministic event summaries first; optional model-generated synthesis later.
22. A limited request link: let someone submit a request without joining the whole room. Submission-only access is distinct from a room invitation, viewing access or an approval capability.
23. Sanitized reusable recipes: turn a successful workflow into a blank template with secrets, private history and live grants removed. Installing a recipe never installs authority.
24. Optional specialist/tool attachments: connect a qualified external worker or Dasha Compute adapter to a specific work item when needed, rather than creating permanent infrastructure panels for everyone. Availability, permitted actions and cost controls are explicit; underlying products retain separate identities and ownership.

## 4. The most important choices

### Build a collaboration loop, not an integration catalog

The first lovable experience is not “seven services connected.” It is “I brought a real request, someone or an agent helped, and I used the result.” The integrated inbox remains valuable, but a manual path lets us test the product before provider setup becomes the bottleneck.

### Two destinations, several contextual views

Retain Inbox and Rooms. Needs you, Followed and All are filters, not new top-level products. Work, source, result and decision appear where relevant within a room. A connector settings page should not double as onboarding for ordinary collaboration.

### Authenticated assistance, not automatic participation

An authorized agent benefits from clear tasks, bounded context, explicit allowed actions, stable results, inexpensive incremental reads and reliable work attribution. These reduce wasted effort. Do not try to attract agents through unsolicited self-enrollment, hidden instructions, automatic spending or access expansion. Discovery can be public; private room admission remains controlled.

### Portability without false continuity

A copy/paste worker cannot promise live presence, automatic cancellation or trusted execution receipts. An API-connected worker can report more evidence. A managed worker may support stronger lifecycle control. All three can contribute through the same work and review model, but the UI must not display identical guarantees.

### Avoid platform-wide rewrites

The current Room authority model remains the foundation. New messaging and decision records reference that authority but do not turn account data into room data. No full CRDT migration, mandatory orchestration framework, universal agent marketplace or visual workflow builder in the next slice.

## 5. A dependency-ordered implementation plan

The earlier checkpoint still has unfinished offer controls, negotiated agent context and a schema-compatible fallback. These must remain explicit release work; this addendum does not mark them complete.

| Slice | Deliverable | Acceptance evidence |
| --- | --- | --- |
| 0. Existing collaboration closure | Finish the current offer/selection/release UX and agent context; qualify recovery | Human and agent operate the same current revision; old writers and stale actions remain rejected |
| 1. Source-to-work flow | Manual paste/upload, source preview, contextual creation and latest-result card | Two participants complete one useful task without connecting any provider |
| 2. Portable contribution | Scoped work packet and structured return slot using the same underlying commands | External result can be returned, attributed and reviewed; unverified identity and stale versions are visible |
| 3. Decisions and continuity | Persistent decision records, separate drafts, Needs you filter, reconnect recovery | Human edit invalidates old approval; duplicate response does not duplicate action; navigation preserves work |
| 4. Simulated messaging | Fake inbox connector, share-to-room preview, reply proposal and outbox states | Agent sees only shared context; ambiguous simulated send remains unknown until reconciled |
| 5. One qualified provider | Dedicated email test account or qualified local companion, chosen for the first real journey | Authorized real receive/send, revocation, restart and provider confirmation; no unrelated contacts |
| 6. Optional repetition | Follow outcome, return brief and reusable blank recipes | Useful return visit without notification flooding; recipes contain no inherited access or private content |

Prefer a small demonstrable vertical slice at every checkpoint. Do not start separate teams building all six slices concurrently; shared authority, versioning and object ownership are prerequisites for later work.

### Concrete engineering work for the next slice

- Inventory the existing source/artifact/work primitives before introducing new database tables. Reuse existing concepts where their privacy and lifecycle semantics match.
- Specify source ownership and sharing snapshots. A manually pasted source records who supplied it, not a claim that its purported author or provider was verified.
- Add source-to-work commands with current room/member revisions and exact retry behavior.
- Add the source preview and a latest-result view using existing panels. Preserve independent drafts rather than adding another editor framework.
- Use synthetic fixtures for a research request, a document review and an external-message reply. Include two sources describing similar work in different private contexts.
- Test accepted versus proposed artifact revisions; owner release; stale external returns; disconnected clients; unauthorized source reads; and duplicate submissions.
- Capture normal, mobile, keyboard and failure-state screenshots. Record simulated-user findings as simulations and actual API-agent results separately.
- Package the qualified checkpoint before adding a provider. No account connection, deployment or external sending is authorized by this planning document.

## 6. Questions worth settling through prototypes

1. Is a source preview enough for users to understand who will see the material, or is a short audience label also needed throughout the flow?
2. Is Inbox best understood as personal communications, actionable requests, or both behind clear filters?
3. Can a first-time user finish a useful task without understanding agents, protocols or work claims?
4. Does the current-result card reduce transcript reading, or hide disagreement that should remain visible?
5. When does asking another worker help more than improving the original request?
6. Can a person reliably distinguish a manually returned contribution from a verified connected-agent result?
7. Which interruptions actually deserve immediate attention, and who can dismiss or snooze shared decisions?
8. Should follow-up edits create a new work item or a new attempt under the existing item? Keep external protocol tasks separate either way.
9. How much source history does a worker need to be effective without unnecessary disclosure?
10. What does a shared source do when room membership changes? Admission must revisit access rather than silently broaden it.
11. What useful functionality remains when the local companion is asleep or an AI allowance is exhausted?
12. Can a workflow be reused safely without its private inputs or historical permissions?

Prototype the first six before adding a broad automation surface. The strongest next move is to make one collaboration unusually easy, then let repeated usage reveal which integrations deserve investment.

## Research limits and checkpoint

Primary sources were reviewed on September 8, 2026. Product docs establish documented behavior, not independently tested performance. The new n8n ecosystem paper received a partial review only. The guessed n8n overview route was unavailable; its concrete Gmail node documentation supplied the approval evidence instead. No new source-code audit or user study was performed. This addendum is a prioritized idea inventory and plan, not a claim of implementation or guaranteed retention gains.
