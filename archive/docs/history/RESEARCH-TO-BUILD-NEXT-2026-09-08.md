# Project Room: the next complete experience

## Recommendation

Finish a dependable conversation-to-outcome loop before introducing another major destination. A person should be able to read a message, reply directly, ask a room for help when useful, receive a contribution, improve it, and review the final reply without losing context or wondering which version is current. An agent should participate in that same flow through explicit, bounded operations rather than a separate agent dashboard.

The ambition stays broad: everyday conversation, unified messaging, interchangeable agents, useful automation, execution, rewards and an opportunity network. The next implementation emphasis is narrower because the underlying quality problem is continuity: preserving identity, intent and evidence as work crosses boundaries. More visible features will not repair a broken transition between a reviewed result and an edited reply.

This plan supplements the project mirror's `research/PROJECT-ROOM-BLUEPRINT.md` and `research/PROJECT-ROOM-DESIGN-GUIDE.md`; it does not replace them. Product scope remains unchanged. Dates and implementation status in older research are historical. Current local baseline inspected for this plan is clean `0a52562`, runtime `2e2c988`, schema 22. The preceding checkpoint records 853 core, 57 focused browser and 23 local Workers checks. These are prior results, not new executions or proof of live deployment.

## What is established, and what is not

The inspected local implementation has account-private Inbox access, bounded email fixtures, selected source sharing, shared work and reviewed-result return, durable provider-shaped creation observations, and a compact review sheet. A local edit invalidates the old review correctly. It does not yet update an already-created provider draft. A created attempt deliberately remains unresolved rather than permitting duplicate creation.

No real mailbox interoperability is established by those fixtures. They do not establish outgoing MIME fidelity, atomic send preconditions, delivery, human satisfaction or retention. The public staging URL is not evidence that the current local runtime is deployed there. This work neither connects mailboxes nor enables sending, compute charges, payments, publication or deployment.

The important distinction is between a tested component and a usable service. The next release needs an understandable recovery path, a dedicated-account trial and an operational handoff, not only a larger test total.

## Research findings and their limits

### Collaboration without compulsory shared editing

Front documents visible draft ownership and explicit takeover with one editor at a time. Drafts in shared conversations inherit that audience, whereas personal drafts require deliberate sharing. This is a useful precedent for making the audience and current editor legible at the draft itself. It is not evidence that a Front editing indicator prevents changes through an outside mail client. [1]

**Project Room decision:** retain private-by-default drafts and selected sharing. Use a current owner for controlled writes, and preserve contributions as alternatives when simultaneous work is valuable. Do not adopt automatic sharing merely because another product does it. Presence is useful feedback; revision checks enforce the write boundary we actually control.

### Agent status should describe useful events

Linear separates agent sessions from semantic activities and exposes working, waiting, error, complete and stale states. Its guidance asks for prompt acknowledgment and explicit delegation identity. These are product integration conventions, not a correctness proof for an external operation. [2][3]

**Project Room decision:** show a compact status attached to the relevant work, with detailed evidence available on demand. A heartbeat means contact, not progress. An agent saying it is finished produces a result for review; it does not prove sending, merging or payment. Avoid narrating every tool call into the social conversation.

### Correction is a primary interaction

Amershi and colleagues' CHI 2019 work proposes 18 human–AI interaction guidelines and evaluates them with 49 practitioners across 20 products. Relevant guidance concerns contextual information, efficient invocation, dismissal, correction, and cautious adaptation. This evidence supports designing recoverable interactions; it does not establish that our exact interface will improve retention. [4]

**Project Room decision:** make an agent contribution editable and dismissible. Keep the prior version available. Correcting a reply should happen where the reply lives, not in a settings page or an agent transcript. Stable navigation matters more than an interface that keeps guessing which feature should move into view.

### Converging text does not authorize an action

Ink & Switch's local-first work discusses both simultaneous editing and proposed changes that can be selectively accepted, alongside understandable document history. Its prototypes explore data ownership and collaboration; they do not establish that automatic merging is suitable for recipient lists, approvals or financial obligations. [5]

**Project Room decision:** separate collaborative artifact content from consequential decisions. Rich-text collaboration can eventually use an appropriate merge model. The exact approved artifact, its audience, and an outside action need separate version-bound records. Never let an automatic merge silently expand recipients or transform two conflicting decisions into approval.

### Durable orchestration does not make every retry safe

Temporal explicitly recommends idempotent activities and explains that an activity may execute again when a worker completes an outside effect but fails to report it. Provider-enforced idempotency keys, where supported, help with that boundary; workflow replay alone does not provide them. [6]

**Project Room decision:** reuse the current journal before considering another orchestration platform. Distinguish retrying a local command to retrieve its original receipt from repeating an external effect. An unknown attempt must remain inspectable without offering a misleading universal Retry button. Later compute and payment adapters must qualify their own deduplication semantics.

### Email editing has a narrower verified contract

Microsoft documents message PATCH, a successful 200 response with the updated message, and draft-only edits for fields including body and recipients. Omitting unchanged fields is recommended. The inspected message-update reference does not specify an atomic `If-Match` contract for this operation. That absence is not proof that conditional updates are unsupported; it means we have not qualified them. Documentation for Dataverse or other Graph resources cannot fill that gap. [7]

The message resource describes `changeKey` as a version, distinct from message identity. Treat the value as opaque. A new value is evidence of a different version, not a sequence number to sort. [8]

Graph's read API can return text or HTML representations and can retrieve MIME with `$value`. Therefore a text-shaped preview alone does not demonstrate that all native outgoing content has been reviewed. [9]

**Project Room decision:** start with a non-executing, body-only update proposal using the recorded provider identity. Preserve original intent, observed draft and proposed local text separately. Compare readback without claiming the update caused what is now visible. Keep real transport disabled until conditional-write and representation behavior are qualified in a dedicated mailbox.

## Questions resolved into defaults

These are product decisions, not newly established facts about customer demand.

| Question | Default choice | Revisit when |
| --- | --- | --- |
| What should a newcomer see? | Inbox and Rooms, with the current conversation leading | Observed sessions show an orientation problem |
| Is every conversation a task? | No; ordinary chat and direct replies stand alone | Never make work mandatory merely to simplify implementation |
| Where should agents appear? | As identifiable participants and contextual help | A distinct administration need emerges |
| Should agents all wake for every message? | No; mentions, assignments or bounded routines select activity | A room explicitly enables a different charter |
| Who owns a shared edit? | One accountable writer; others can propose alternatives | A specific artifact benefits from simultaneous editing |
| Does ownership lock an outside application? | Only if that destination enforces it | Provider qualification proves a stronger guarantee |
| How are local and provider drafts related? | Separate versions with an explicit proposed update | Never silently collapse them |
| What if the provider changed recipients? | Preserve and expose them for a fresh decision | Explicit recipient editing is separately implemented |
| What does a matching readback prove? | Observed content matches the proposal | A retained provider receipt supplies additional evidence |
| What should happen after an unknown write? | Inspect the original attempt; no automatic repeat | A verified provider contract makes repeat safe |
| Should all details be visible? | Content and consequential context first; history on demand | Repeated usage justifies a user-pinned detail |
| Must every agent use MCP? | No; canonical API, thin MCP and manual returns | Host compatibility testing changes the best onboarding route |
| Is copied text a connected agent? | No; show Awaiting update without simulated presence | A verified callback or direct connection exists |
| How should success be displayed? | Separate result, review, acceptance and outside effect | Never flatten them for cosmetic simplicity |
| What remains useful without paid AI? | Conversation, manual contributions, review and user-owned agents | Resource costs justify clear, measured limits |
| What is the next growth investment? | Invitations to useful work and reusable accepted results | Private collaboration demonstrates repeat value |
| When should public bounties expand? | After contribution quality, moderation and payment exceptions are qualified | Not merely when a listing page can be built |
| Should we add a workflow engine now? | No; first qualify the existing journal against complete flows | Measured operational needs exceed it |
| Can simulated testing prove delight? | No; it proves mechanics and generates hypotheses | Actual participant observations provide evidence |
| When is the whole goal done? | Only after working scope and operational readiness are verified | A local prototype or a plan is insufficient |

## Product structure and design choices

The normal experience should remain visually small: a conversation list, its content, a composer, and a contextual way to ask for help. Work opens alongside the conversation rather than replacing it. On mobile, opening details should retain the prior conversation, reading position and draft for return.

For draft editing, compare two options. A permanent dual-editor view would make every reply look like conflict resolution. A focused comparison sheet keeps routine replies simple and makes both versions available only when needed. Choose the focused sheet, with a persistent indication that local changes have not yet reached the provider. This is a design judgment to test, not a demonstrated user preference.

Proposed visible labels are intentionally short: **Review changes**, **Keep writing**, **Check draft**, and **Review reply**. “Saved” must identify local saving if provider state differs. Do not show “Synced” because an update was prepared, or “Sent” because a review was recorded. A successful-looking green badge cannot replace missing evidence.

In a conflict, show the mailbox version and the proposed text with unchanged context grouped nearby. Recipients remain visible before consequential approval. Keep the user's writing intact if the provider is unavailable. Do not require users to interpret identifiers, revision hashes or transport responses. Those belong in a private details layer for support and debugging.

For agent work, show one meaningful status near the work item and the latest useful artifact. Tool logs and intermediate proposals remain available, but are not ordinary room chatter. A question requiring the user should be distinguishable from a routine progress update. A quiet room should be an acceptable product state, not a reason to manufacture agent activity.

## Implementation sequence

### 1. Qualify updates without executing them

Extend the existing provider-reply module, not the HTTP surface or database. Build an update proposal from the authenticated account, current saved local draft, original creation attempt, confirmed provider draft ID and latest recorded observation. Reject changed source context, account/connection changes, stale attempt revisions, unsupported bodies and incomplete attachments.

Preserve three values: original creation intent, observed provider draft, and proposed local text. The proposal changes only the body. It must not rewrite recipients, subject, sender or attachments. When the visible text already matches, return an explicit no-update state rather than generating a redundant PATCH.

Revalidation must reconstruct the proposal from current state and compare the full result. A hash is an integrity check, not an access grant. A readback comparison must retain uncertainty about causation and must never grant review, sending or automatic retry. This is the bounded first implementation slice.

### 2. Journal the update lifecycle

After the pure contract is tested, introduce an explicit child update attempt beneath the original creation attempt. Keep creation intent immutable. Record preparation, dispatch intent, provider evidence and observation separately; do not overwrite the original plan to make an edited reply appear current.

Only the winning nonduplicate dispatch transition may call the adapter. Capture expected revisions before reads. A late response can contribute evidence about its own operation, but must not overwrite newer approved state. Unknown updates block automatic replay; cancellation before dispatch and resolution after dispatch need different meanings.

This stage requires migration, old-writer retirement, deterministic replay, cold-package recovery and restart tests. It should not be squeezed into a documentation-only compatibility change. Do not expose a public provider-write endpoint merely to simplify fixture tests.

### 3. Add the focused comparison interaction

Reuse the current review sheet and private composer. Introduce no new destination. Bind the displayed before/after content to one update proposal; invalidate its action if local writing, source, account or provider observation changes. After a lost acknowledgment, retain only the metadata needed to check the same attempt. Keep body content out of general activity logs and cross-account browser state.

Test direct replies without rooms and room-assisted replies through the same component. Inspect desktop and narrow-screen screenshots for reading order, wrapping, prominent recipients and a single dominant next action. Error recovery deserves screenshots too.

### 4. Qualify one dedicated mailbox

With separate authorization, test create, read, edit, reconnect and uncertain outcomes against a dedicated account and controlled recipients. Test outside-client edits between read and write. Establish whether conditional updates are actually enforced for this message operation and how native body representations differ. Record provider behavior rather than substituting API documentation for observed interoperability.

Real sending remains a separate gate. Resolve the final-read-to-send race and determine exactly what evidence supports provider acceptance versus delivery. Never claim an atomic guarantee that the provider does not offer.

### 5. Complete agent and manual parity

Run the same bounded assignment through a real compatible agent client and a manual copied-brief return. Compare identities, scope, revision handling, partial output, takeover and evidence. A manual return should be useful without pretending it is live execution. A connected agent should get only the permitted context and enough structure to stop or ask a focused question.

### 6. Add useful automation before a larger marketplace

Start with deterministic routing and draft suggestions, then bounded execution through the existing attempt/result model. Keep provider-specific execution and cancellation behind adapters. Continue Dasha qualification in its separate ownership lane. Reward agreements, accounting, payments and public discovery stay on the broader roadmap, with their own approval and operational gates.

## Acceptance and reconsideration

For the first slice, require deterministic preparation, no mutation of original history, no provider I/O, correct account boundaries, stale proposal refusal, retained changed content, opaque-version handling, explicit no-op behavior and no automatic retry/send authority. Run the complete core suite and a cold-runtime package test. Since no UI changes are made in this slice, existing screenshots are historical evidence, not new visuals.

For the integrated flow, require both a direct reply and a room-assisted reply, interruption and return, unavailable provider, concurrent edits, rejected review, unknown update, changed account and recovery after restart. Each state must leave a useful next action without inventing success. Actual agents test their supported routes; simulated-human checks remain labeled.

Stop adding features to a flow when its next failure cannot be explained simply. Prefer fixing the transition or making its authority explicit. Reconsider the email-first order if dedicated-account qualification remains externally blocked while native collaboration can deliver a complete useful improvement. That is a scheduling change, not abandonment of messaging.

## Sources

All web sources accessed September 8, 2026, Pacific time. Product documentation can change. No authenticated competitor session or live provider test was conducted for this research.

1. Front. [How to share and collaborate on drafts](https://help.front.com/en/articles/2216). Edited July 17, 2025. Draft audience and editor takeover.
2. Linear. [Developing the Agent Interaction](https://linear.app/developers/agent-interaction). Current developer documentation. Sessions and activities.
3. Linear. [Interaction Best Practices](https://linear.app/developers/agent-best-practices). Current developer documentation. Acknowledgment and delegation.
4. Saleema Amershi et al. [Guidelines for Human–AI Interaction](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf). CHI 2019, DOI 10.1145/3290605.3300233. Guidelines and evaluation scope.
5. Martin Kleppmann, Adam Wiggins, Peter van Hardenberg and Mark McGranaghan. [Local-first software: You own your data, in spite of the cloud](https://www.inkandswitch.com/essay/local-first/). 2019. Collaboration, proposals and history.
6. Temporal. [Activity Definition](https://docs.temporal.io/activity-definition). Idempotency, repeat execution and provider-enforced deduplication.
7. Microsoft. [Update message](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0). Graph v1.0; inspected reference lists March 13, 2026 update. Editable fields and response semantics; conditional-update guarantee remains unqualified here.
8. Microsoft. [Message resource type](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0). Graph v1.0. Identity and version fields.
9. Microsoft. [Get message](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0). Graph v1.0. Body representation and MIME retrieval.
