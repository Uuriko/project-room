# Next: deliberate requests for a reply

Design/implementation plan, September 8, 2026. **In progress, local only.** The
canonical request rules, schema/writer 12, recovery audit, current/selected/anchored
history reads and shared direct/CLI/MCP actions are implemented. Human composer,
request-specific current attention and complete actual-agent/simulated-human
acceptance remain required. This foundation checkpoint is not feature completion.
Root integrates; independent agents review bounded contracts/tests.

## Job and product boundary

A person or agent needs an answer from one particular room participant. The
recipient may be disconnected, decline, ask an ordinary clarifying question, or
answer later. Both parties must distinguish addressing, reading, answering and
acceptance without reconstructing intent from chat prose.

Reuse existing conversation for the text and work for deliverables. Offer an
explicit contextual **Request a reply** choice with one recipient. Ordinary
messages, addressed messages and replies stay ordinary. A request grants no
external permission, starts no model, consumes no compute and creates no claim.
Do not turn mentions into obligations or silently convert old messages.

The first complete slice includes human and agent create/read/respond/cancel,
current attention, durable historical resume, exact retries and recovery. It is
not complete with only a badge or a new tool. No new main navigation, dashboard,
notification channel, recurring job, multi-recipient broadcast or paid feature.

## Lifecycle and authority

The opening message ID is the durable subject; a separate business operation ID
continues to identify each attempted write. Text and original actors are immutable.

| From | Explicit action | Actor | Result |
|---|---|---|---|
| None | Request reply | Active participant allowed to post | Open, revision 0 |
| Open | Answer | Exact active recipient | Answered, next revision |
| Open | Decline, with explanation | Exact active recipient | Declined, next revision |
| Open | Cancel, with reason | Requester or explicit owner override | Cancelled, next revision |

Terminal requests never reopen, reassign or auto-expire in this slice. A new
follow-up can remain in the same conversation. Recipient unavailability is a
current condition, not implicit cancellation; show it to the requester. Answered
means an attributable answer exists, not that the requester agrees or that work
was completed/reviewed/approved. If the outcome needs those gates, link existing
work and use its lifecycle.

An active recipient may still answer/decline after the requester becomes inactive:
retain that historical requester identity under a narrowly validated request-response
exception. Do not relax ordinary new-message recipient validation. Owner override
means the actual room owner, not any participant with steer/manage permissions.

Every write checks current membership, exact actor, expected request revision and
allowed transition. Ordinary comments, reactions, acknowledgements and read markers
never resolve a request. Owner override must be separately attributable. Require
one other active room recipient on creation; reject self-requests and unsupported
recipient identities instead of guessing. Existing anti-abuse/request limits stay
in force; decide a bounded retained-request cap before adding new state.

## Canonical data and compatibility

Prefer extending the existing `message.posted` command with mutually exclusive,
strictly validated bundles rather than adding another message-producing event:

- Opening: `requestKind: "reply"`, existing `toMemberId`, body and optional explicit
  work/reply links. Opening event, subject and actor remain canonical message data.
- Response: selected request subject, expected request revision and
  `responseOutcome: "answered" | "declined"`, with body. Derive or strictly check
  reply/recipient/work links against the selected request. Do not accept author IDs.
- Cancellation: a separate explicit event with subject, expected revision and reason.

Project a request map with immutable opening event/message, requester, recipient,
revision, current status, terminal event and nullable response message. Message
append and request transition must commit atomically. Preserve existing message,
native text, discussion, export and replay readers; enumerate every message consumer
before changing the event shape. Keep source text, evidence and requests distinct.

This changes replay semantics even without a new SQL table. It therefore requires
a new Room writer/schema revision, genuine frozen v11 migration/replay/rollback,
already-open old-writer refusal and updated recovery auditing. Never relabel a
version number as migration proof. Local observer format changes, if needed, also
need explicit compatibility; do not reinterpret v1/v2 pending directories silently.

## Thin agent surface and human flow

Use the same server command and projections for UI, direct client, CLI and MCP:

- List my incoming/outgoing requests, bounded and filtered explicitly.
- Read one request: exact opening/response bytes, event and actor references,
  current status/revision/allowed actions, work and room-instruction pointers.
- Explicit request, answer/decline and cancel commands with stable operation IDs.

Validate response selection, viewer identity, exact submitted fields, event/message
lineage and applied revision. A duplicate receipt confirms the original operation,
not the request's current state. Never silently rebase an answer or cancellation.
Unknown outcome retains the original operation and exact retry; cancellation of
the network call does not imply rollback. Refusals give one truthful next action.

Selected request discussion must also work without linked work: opening plus exact
reply descendants, excluding independent request/work branches. Expose a bounded,
frozen page of those messages and a last-relevant-context sequence/event reference.
Ordinary clarification changes that reference, not the request revision/status.
Explicit answering/declining must include the inspected context reference as well
as request revision. A newer relevant clarification refuses the write with an owned
refresh that preserves draft text; reactions/unrelated threads do not invalidate it.
Require a completed context window before offering an answer basis, not a partially
drained page. This is an explicit design choice, not an existing freshness guarantee.

Human entry remains the existing composer/selected conversation. The contextual
request choice adds a recipient and compact mode indicator. Request status stays
inline; only the recipient gets explicit Answer/Decline and requester/owner gets
Cancel. Ordinary Reply stays ordinary. Preserve Enter-to-send in the chosen mode,
Shift+Enter, mobile behavior, input-method composition, focus, owned drafts and
session cleanup. Unknown writes survive the same supported close/reopen boundaries
as existing action forms; do not imply persistence after an unsupported reload.

Answer opens the existing composer with an “Answering [request]” chip and Send
answer action. Reply without answering returns to ordinary mode for clarification.
Bind mode, subject, revision and context basis to the owned draft; never carry them
silently to another thread.

## Current conditions versus retained history

Current attention includes an open request for its recipient and an answer/decline
for its requester, keyed by exact subject/terminal event. Cancellation suppresses
the open request. Requester unavailable-recipient attention needs a distinct
current signature. Local ack affects only that notice, never the canonical request.
Do not repeat an acknowledged unchanged terminal result on every work revision.
For open requests, a new relevant clarification also changes the attention signature,
so it can reappear after local acknowledgement without becoming answered. Review the
clarification selector against unrelated and nested-request branches before shipping.

Historical discovery is separate: a request opened and answered entirely between
polls must remain discoverable. Reuse frozen selected-discussion pagination ideas,
but its existing numeric `since` is insufficient for durable anchored resume.

Design a canonical resume token bound to version, room, room-created event, viewer
identity, explicit selection/filter, consumed sequence/event and frozen horizon.
Authenticate every page; verify retained anchors against authoritative event rows.
Return the completed resume checkpoint only after the selected window is drained.
New events appear on the next window. Refuse missing/replaced history rather than
resetting progress. Key rotation with the same proven identity can resume; account
or identity changes need explicit reconciliation. Tokens contain no credentials
and confer no access. Define empty-page advancement and sparse filtering precisely.

Verify both consumed-boundary and frozen-horizon anchors. Historical incoming/outgoing
selection uses immutable actors and retains all transitions; never filter a frozen
page by today's status projection. Current lists may separately filter status.
Empty windows advance to the verified horizon, not just the last matching request.

Do not conflate the historical consumer checkpoint, local notice acknowledgement,
human read marker, canonical answer or work completion. All five remain separate.

## Verification and rollout order

1. Inspect message consumers; settle exact schemas, retention cap and cursor
   invariants. Write executable transition and response fixtures before UI wiring.
2. Implement canonical events/projection/authority and immutable retry receipts.
   Qualify genuine v11 migration, replay, old-writer fence and recovery integrity.
3. Add selected/list/history reads with full anchor, byte and pagination validation.
4. Extend shared client/CLI/MCP action descriptors and optional attention without
   guessing obligations or widening permissions. Preserve manual/BYO usefulness.
5. Add contextual composer/actions using existing owned-retry/focus conventions.
6. Exercise two actual agents and simulated human journeys; inspect screenshots.
   Package a frozen source and record exact evidence. Local first; no deployment
   or native vendor acceptance claim without its separate proof and authorization.

Required cases: legacy directed text is not a request; ordinary clarification does
not answer; wrong-recipient/self/inactive actor refusal; concurrent answer/cancel;
stale revision and exact retry after later terminal changes; inaccessible requester;
unknown write and receipt tampering; canonical response authorship/bytes; scoped
discussion branches; sparse/frozen pages, empty windows and between-poll terminals;
restart, key rotation, restore/history replacement; old acknowledgement cannot
clear replacement; stop/cancel/lost response; no human read-marker changes; mobile,
keyboard, enlarged text, session switch and preserved drafts; no external action.
Specifically test clarification after local acknowledgement, clarification during
composition, response after requester deactivation, and terminal transition between
frozen pages. These cases emerged from independent review of this plan.

Acceptance: human requests an in-room answer; agent disconnects/reconnects and
discovers it; ordinary clarification provides context without clearing it; agent
explicitly answers; another participant independently reads the exact exchange
after reconnect. Work acceptance/completion and human approval stay untouched.
Report simulated mechanics and actual agent participation separately from human
preference, retention or native host acceptance.

## Now / next / later

- **Now:** finish this reply-request slice: compact human composer/actions with
  owned drafts and exact unknown retries; explicit opt-in request attention; actual
  agent reconnect/clarification/answer and simulated human screenshot acceptance.
  The earlier client-only attention-read optimization is complete; preserve it.
- **Next:** qualify a distinct v12-compatible fallback and hosted recovery before
  release. Native-host acceptance remains a separate gate; stdio adapter tests are
  not Claude/ChatGPT/Grok/Instinct installation or provider acceptance.
- **Later:** eligible-work suggestions and opt-in standing roles; atomic compact
  observations if measured network costs warrant a new protocol; scoped repository/
  Dasha fake-runner attempts. Real providers, payments, execution and publication
  require their own reviewed contracts and explicit authorization.

## Remaining integration decisions settled at the foundation checkpoint

- Keep every human mode in the existing composer; no new main navigation. Treat
  request A → B within one root thread as a draft ownership change, not a harmless
  thread switch. Pin subject/revision/context to the draft and unknown command.
- Extend opt-in draft recovery through a validated new branch. Reconstruct only
  the exact permitted payload. An inactive requester is allowed only for a genuine
  response; ordinary targeting stays strict. A terminal current read is not proof
  that an earlier unknown write failed.
- Existing private observer v2 is not extensible in place. Add an operator-selected
  v3 with a **new directory**, explicit binding/filter/schema and no automatic
  migration, acknowledgement copying or reset. Preserve existing v1 stdout and
  v2 work/instruction inbox behavior.
- V3 conditions: open incoming request keyed by subject/revision/context event;
  outgoing answer/decline keyed by terminal event; outgoing unavailable-recipient
  condition. Persist metadata/read pointers only. New relevant context replaces
  the exact pending notice; unrelated work/reactions/names stay quiet.
- V3 requires a service support indicator: absent request state means either no
  requests yet or an older service. Never interpret unsupported service as an
  empty inbox and clear pending notices. Capacity must cover 500 work conditions
  + 500 request conditions + one instructions notice (1001), without truncation.
- Selected context emits no reusable checkpoint; `hasMore:false` completes that
  read. History alone emits a consumable `completedCheckpoint`. Both use bounded
  pages; history rows carry immutable requester/recipient/work identity so a
  terminal-only continuation can independently verify its selection.
- Recovery/migration evidence covers genuine v11 data, not just a rewritten
  version marker. Reserved historical policy/map collisions, including JSON null
  and checkpoint-hidden values, refuse before any migration writes.
