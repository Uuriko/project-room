# Portable work, quiet reminders, and safe return

Research and implementation plan · September 7, 2026

## Decision

Make one assignment easy to take to any AI and bring back to Room. Keep Room the place where people coordinate, review, and decide. Copying a prompt must not pretend an agent connected or started working.

Build in complete checkpoints, not one large automation release:

1. **Now:** selected-work packet, exact preview, optional source context, reliable copy fallback, manually returned proposal, and honest access help. No new database schema or provider.
2. **Next:** private, durable in-app reminders. This requires a separately tested schema migration; do not substitute browser storage for durable reminders.
3. **Then:** a user-started, notify-only assignment watcher with its own durable checkpoint.
4. **Later, by explicit choice:** connected execution, off-app delivery, hosted AI, recovery authenticators, and usage plans. These must not be prerequisites for a useful free product.

The first checkpoint is intentionally useful without any integration: choose work → copy → use an AI you already have → return a proposal → review normally. It does not launch agents, spend money, claim a code scope, complete work, or publish anything.

## Research synthesis

These are design inferences from the sources, not claims that the proposed UI has been validated with human participants. Three independent research lanes examined portability, reminder durability, and recovery/UX. Existing repository behavior was inspected alongside the documentation.

- Mixed-initiative systems should combine direct manipulation with assistance, and attend to invocation, interruption, and uncertainty. The human should be able to start, correct, or dismiss help. Here that means contextual actions, an editable/manual return, and no unsolicited agent launch. [Horvitz, CHI 1999](https://www.microsoft.com/en-us/research/publication/principles-mixed-initiative-user-interfaces/), [Amershi et al., CHI 2019](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf)
- A portable representation can be valuable without a connector: Linear supports copying issue content as Markdown. Its agent model also keeps human ownership distinct from delegated agent activity. Borrow portability and accountability, not status labels we cannot observe. [Linear editor](https://linear.app/docs/editor), [Agents in Linear](https://linear.app/docs/agents-in-linear)
- MCP's consent principles support narrow, understandable sharing. Token passthrough is not an acceptable shortcut to connectivity. Export a task, not a credential or the whole room; authenticate any later API connection separately. A packet is not an MCP server or a security sandbox. [MCP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- A2A distinguishes tasks, context, and artifacts, but leaves artifact version linkage and acceptance to clients. Carry a work revision and correlation ID; keep Room review authoritative. Neither a packet ID nor an imported producer name verifies authorship or correctness. [A2A task lifecycle](https://a2a-protocol.org/latest/topics/life-of-a-task/)
- A reminder should not hide the underlying work. Linear exposes explicit rescheduling and cancellation. Borrow this small interaction without importing a notification center full of unrelated features. [Linear Inbox](https://linear.app/docs/inbox)
- Cloudflare alarms have at-least-once execution and one scheduled alarm per object. Its SQLite reference makes alarm scheduling asynchronous, whereas this app's transaction adapter is synchronous. In-app due-at-read reminders avoid this extra delivery system; background delivery needs a proven crash-safe scheduler, not an in-memory timer. [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [In-memory state](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/)
- Account recovery must establish ownership. A room URL, saved reference, or display name cannot do that. Recovery codes and passkeys would be new authenticators with enrollment, revocation, and origin decisions; this checkpoint provides access guidance, not invented recovery. [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html#account-recovery), [WebAuthn RP identifier](https://www.w3.org/TR/webauthn-3/#relying-party-identifier)
- Keep advanced controls contextual and allow manual copying if clipboard permission fails. Do not read or erase the clipboard automatically. [Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/), [W3C Clipboard API](https://www.w3.org/TR/clipboard-apis/)

## Unanswered questions, and decisions for this build

| Question | Current decision / remaining gate |
| --- | --- |
| What is the smallest useful export? | One work item: title, definition of done, state, revision, and return instructions. Linked source excerpts are opt-in. |
| Does copying give permission to execute? | No. Explicit text says to return a proposal and ask before external changes; prose is not enforceable access control. |
| Is exported prose guaranteed free of secrets? | No. Application credentials are excluded by construction, but user-authored work text can itself be sensitive. Show the exact text and a sharing notice. |
| Can an outside model claim it finished the task? | It may report a result; Room records a proposal from the authenticated submitter. No automatic receipt, review, approval, or completion. |
| What if work changes during the handoff? | Compare the specific work revision, not global room sequence. Reject an outdated basis without losing the draft. A user may explicitly post it as an older proposal, still never as completion. |
| How do we verify the outside producer? | We do not in the manual path. Reported provenance remains unverified. Authentication identifies the Room submitter only. |
| What does a reminder mean? | Remind me inside Room while the work is unresolved, even if ordinary work revisions change. Not an off-app notification. |
| What does resolved mean? | Reuse `terminalWork()`: completed-but-awaiting-required-review/decision is not resolved. |
| Can an expired guest return? | Not by display name or a plain room link. Ask the inviter for access; never silently create or guess the previous identity. |
| Should we add a new AI subscription now? | No. Prove the manual/BYO-agent loop first. Hosted help later must preserve a strong free baseline and explicit cost limits. |

## Checkpoint 1 — portable handoff and return

### Data and trust boundary

Create one small shared, pure packet module, usable by the browser and agent client. Construct output with an allowlist rather than serializing snapshots or `orient()`, which contains other work.

Envelope: format version, random packet ID, room ID, work ID, work revision, export timestamp. Content: selected work title/definition/state and optional linked source IDs/excerpts. Omit credentials, account/session metadata, member directory, other work, unsent drafts, arbitrary evidence URLs, and unselected conversation. Do not invent a signed or authoritative packet.

A plain return location can require normal Room access; never embed an invitation or key. Keep provider launch URLs out of scope. No third-party request should occur when previewing or copying.

Provide a small return template carrying packet/work identity and basis revision. Treat pasted output as untrusted data: bounded fields and length, rendered as text, no URL fetching or command execution. The person may add their own result text and review it before posting.

### Service and event semantics

Reuse the existing authenticated `MESSAGE_POSTED` command and work-linked conversation. Add optional, strictly validated proposal metadata containing packet ID and basis revision; an explicit stale-basis acknowledgement is permitted only as proposal context.

The existing command ledger must resolve identical retries before consulting the current work revision. This preserves success after a lost response; changing an already-used command ID remains a conflict. Check work existence and basis in the same transaction as saving the message. An unrelated message must not make a proposal stale.

Store and display provenance as reported/manual. Preserve normal work state, revision, claims, receipt, review, approval, membership, and read cursor. A proposal is a conversation contribution, not a new authority-bearing workflow state. Existing commands without metadata retain their behavior.

Compatibility limit: schema remains v7, but older application code does not implement this feature. Its validator rejects these new command fields, and its replay may omit proposal decoration while preserving message text. Prefer a feature-aware roll-forward fix; do not call an older app a full-fidelity proposal rollback.

### UI

Inside an individual work item's existing Details disclosure, add **Use my AI**. Its dialog contains an exact selectable preview, optional **Include source messages**, and **Copy**. Successful writing says **Copied**, never Sent or Working. Failure leaves the text selectable and tells the user to copy it manually.

The same contextual flow offers **Add result**. Show the selected work, result text, and packet reference/basis. A stale return stays editable; explain that the work changed and offer a deliberate older-proposal action. Disable duplicate submission while pending, preserve the same command on uncertain retry, and clear only after confirmed save.

All asynchronous actions belong to the current account, room, session binding, and client generation. Closing or switching sessions must prevent late success text, copied old data after a deferred operation where avoidable, or submission under a new identity. Clear sensitive dialog text on logout. Do not persist private task packets in shared browser storage.

Add short sign-in help: a plain room link does not restore access; an expired/lost guest session requires help from the inviter. Do not call a browser cookie lifetime authenticated access or claim a support request was sent.

### Acceptance tests

1. Deterministic allowlisted packet structure; selected-only sources; unrelated message/work/draft and credential sentinels absent.
2. Packet and proposal size/type limits; unknown fields rejected; returned markup remains inert text.
3. Valid proposal saves one work-linked message and changes no work state/revision or read cursor.
4. Stale proposal rejected; explicit older proposal accepted as a proposal only; future/impossible basis rejected.
5. Lost-response identical retry succeeds even after the work changes; changed ID reuse conflicts.
6. Browser copy success and denied/unavailable clipboard fallback; no false connection status; cancelled dialogs and session switches fenced.
7. Desktop, narrow touch layout, keyboard/Escape/focus restoration, 200% text; screenshot the packet and return flow.
8. Existing core, browser, and Cloudflare tests remain green; public asset lists include new modules exactly.
9. Exercise exported packet with an independent agent and return its actual proposal without fabricating provider telemetry or test results.

## Checkpoint 2 — private durable reminders

One current reminder per `(roomId, memberId, workItemId)`, with revision, due-at UTC, state, creation/update times, and basis work revision for context. Keep a separate private request-receipt table: the public command ledger requires a public event and must not leak personal reminders.

Authenticated GET returns private due/upcoming rows and server evaluation time. POST derives the member from authentication and accepts schedule/cancel with expected reminder revision and a stable request ID. Duplicate receipt resolution precedes date/revision checks. Replaying an old Set after Cancel returns its old receipt and cannot re-arm it. Enforce bounded active reminders and receipt capacity.

Retire reminders atomically when work becomes terminal/superseded or membership/account access is revoked. Reopening/re-enabling does not resurrect them. Ordinary key rotation/logout preserves preferences. No personal reminder appears in shared projection, SSE, audit events, or other members' responses.

Show due reminders quietly inside Catch me up, with scheduling in work Details. Refresh on open/reconnect/tab return and at the next due instant while visible. A closed browser receives no off-app alert. Offer a few presets before custom time; validate timezone/DST conversion and use server time for due evaluation.

### Migration and release gate

Add schema v8 only with reviewed Node and Cloudflare writer fences. Node must continue recognizing historical fence functions. Cloudflare's marker-based v7 triggers must be verified and replaced atomically; leaving them in place would reject every v8 write. Unknown/corrupt guards must fail closed, not be silently dropped.

Test old-v7 open writers, migration rollback on failure, read-only schema checks, Node/Cloudflare parity, overdue restart, revocation/re-enable, two-tab rescheduling, duplicate requests, and unchanged public event/read cursors. A v7 application is **not** a valid rollback after v8 data migration. Prepare a v8-compatible rollback/roll-forward candidate before any hosted migration.

No alarm or recurring job in this checkpoint. Background delivery later needs generation-based deduplication, current authorization checks, bounded batches, retry exhaustion visibility, and a proven repair path for commit-before-alarm scheduling failure.

## Checkpoint 3 — notify-only assignment watcher

Extend the agent inbox tooling with an explicit user-started watch. Configuration identifies one room and member plus a filter version. Keep a durable, local processing checkpoint and pending output; never use or advance the human caught-up cursor.

Persist a notification before advancing its processing checkpoint. Recheck current work before emitting actionable output; avoid loops from the watch's own messages. Start with terminal/console or a local outbox, not automatic Room posting. Use bounded polling/backoff, fixed trusted origin, normal token authentication, visible stop/disconnected status, and no credentials in arguments or logs.

Tests: restart before/after output/checkpoint commits; duplicate event batches; filter changes; revoked credentials; room changes; stale work; no human cursor mutation; no agent subprocess or external execution. Later execution requires explicit scope, budget, cancellation, and outcome rules, reusing Room's claim/review boundaries.

## Recovery and future integration gates

Before offline recovery codes: decide eligible accounts, guest conversion, fresh ownership proof, notification/contact channel, dispute handling, and atomic revocation across account and legacy room credentials. Existing account-key rotation is not all-device compromise recovery.

Before passkeys: settle stable RP ID/origins and enrollment/recovery. Before push/email: choose delivery/retention and request permission in context. Before hosted AI: define a genuinely useful free allocation, explicit paid opt-in, hard spending/iteration limits, and no tool authority inherited from room text. Before MCP/A2A: expose narrow packet/return operations behind separate authentication; protocol adapters cannot bypass Room acceptance or scope claims.

## Working and release method

Root owns product edits; parallel agents research and independently review. Preserve existing data, keys, previews, bindings, dirty work, and unrelated products. Make no new provider, money, DNS, or deployment changes as a side effect of this plan.

For each checkpoint: focused tests → independent review → full regression → browser evidence → source/checkpoint handoff. Report precisely what is implemented, locally verified, and live. Publication is a separate authorized release action, and schema-changing releases have an additional migration/rollback gate. Do not present simulated human testing as interviews or claim all phases complete after the first useful slice.
