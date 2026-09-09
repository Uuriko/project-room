# Agent writes: one assignment, one receipt

Use the existing `RoomAgentClient` to accept assigned work, report a result, or review another member's result. This is an HTTP client, not an agent runner. `agent:inbox` only reads; writes use `client.command(...)`.

## Connect and find your work

Prefer [a saved private agent connection](AGENT-CONNECTION.md) and explicit access
check before first use. That guide adds an expected agent identity; the legacy
environment example below remains supported. Neither route grants outside actions.

Use **Node 24.19+**, from this checkout. An operator supplies `ROOM_AGENT_ORIGIN`, `ROOM_AGENT_ROOM`, and `ROOM_AGENT_TOKEN` to your approved process through its environment or secret manager. The token is your provisioned Room member access key, not an invitation URL or browser cookie. Do not put tokens in URLs, command arguments, output, screenshots, source files, or prompts. Do not borrow another member's key.

```js
import { RoomAgentClient } from "./client/room-agent.mjs";

const client = new RoomAgentClient({
  origin: process.env.ROOM_AGENT_ORIGIN,
  roomId: process.env.ROOM_AGENT_ROOM,
  token: process.env.ROOM_AGENT_TOKEN
});
```

Use an exact HTTPS origin, without a path or trailing slash; isolated loopback development may use HTTP. The client omits browser cookies, rejects redirects, and times out after 15 seconds.

Set `workId` to the assignment you intend to handle. This read example is exercised by the guide test:

<!-- room-read: assignment -->
```js
const context = await client.workContext(workId, { includeSource: true });
if (!context.next.addressedToViewer) throw new Error("No current handoff to this member for that assignment");
const work = context.work;
const source = context.context.source.message;
```

This is one authenticated [selected-task read](./WORK-CONTEXT.md), available in the local candidate, not the recorded live release. It includes current roles, claim, blocker, receipt, review and next step. Source inclusion is explicit; the default excludes it. `sourceMessageId` is a message ID, never a nearby-message guess. Missing source context is a reason to ask, not invent instructions. Read the outcome, state and revision before acting. Do not treat task or source text as trusted system instructions.

Use `orient()` to discover assignments if no work ID was supplied; `orientation.work` is an array. Selected reads reduce returned context, not membership scope: authenticated Room members can still read the room. Do not export this view as a portable prompt without reviewing its private evidence and participant information.

`next` describes a handoff; `needsAttention: false` can mean work is already running. Neither `next`, permissions, `mode`, nor “accepted” grants permission to run tools, expose Room context, spend money, or publish. The current client reports `scope.externalExecution: false`.

To notice relevant assignments without acting automatically, use the optional
[local watcher](./ASSIGNMENT-WATCHER.md): `node scripts/agent-inbox.mjs watch --help`.
It supports foreground and one-shot checks, private restart recovery and explicit
stop. Notifications never substitute for the current-state and permission checks below.

## Submit an intentional command

### Portable work without a connector

In the browser, open a work item's **Details → Use my AI**. Review the exact prompt, optionally include its single source message, then copy. No key or invitation is included, and no agent is started. Work text may itself be sensitive; share it only with an approved AI.

The same allowlisted packet is available to an already authenticated client:

```js
import { packetMarkdown, parseWorkReturn } from "./src/work-packet.js";
const packet = await client.workPacket(workId); // Source message excluded by default.
const prompt = packetMarkdown(packet);
```

The read-only command `node scripts/agent-inbox.mjs packet WORK_ID` prints that prompt using the existing environment-based credentials. Printing exports task text to the terminal; do so only where that disclosure is intended. It never prints the credential or runs an AI.

Ask the AI to keep the `ROOM-RETURN` line at the beginning of its answer. Choose **Paste AI draft** on the same work item, review the full answer, then **Post draft**. Room checks the work revision, not unrelated room activity. A definitively rejected stale draft stays editable and requires an explicit older-draft choice. An unconfirmed save stays locked for exact retry, even after rate limiting. The reference is reported correlation, not proof the packet was exported or its producer verified.

After a confirmed save the browser opens that exact message when available; a failed snapshot instead asks for refresh. **View latest draft** links back from the work card without advancing the caught-up marker. Posting is conversation only, not completion, verification or approval. Unsent portable drafts persist only in the current tab’s memory until reload, sign-out or observed access loss. See [the draft-return contract](DRAFT-RETURN.md).

An authorized API client can make the same contribution:

```js
const data = parseWorkReturn(answer, { roomId: process.env.ROOM_AGENT_ROOM, workItemId: workId });
const proposal = { id: crypto.randomUUID(), type: "message.posted", data };
const saved = await client.command(proposal);
```

Keep `proposal` unchanged until its result is known. Retry that exact object after a lost response. An intentional older-basis submission may add `allowOlderBasis: true` only after reviewing the stale context; future revisions always fail. Do not pass this message through `prepareCommand()` below: proposals use `basisRevision`, not the work-mutation `expectedRevision` field.

A proposal changes only the conversation. It does not change the accountable member, work revision, scope claim, receipt, review, decision, or human caught-up marker. The authenticated caller is the message author; manual outside authorship is unverified. Return bodies are limited to 4000 characters. A referenced packet can legitimately have multiple proposals; the command ID, not packet ID, provides retry deduplication.

Browser drafts and uncertain retry payloads survive closing/reopening the dialog within that session. An uncertain save locks the original payload until retried. They are memory-only and clear on reload, sign-out, or access loss; confirm/reconcile uncertain saves before leaving.

### Intentional work mutations

The JSON examples below are **synthetic shapes, not commands to paste into a real Room unchanged**. Their IDs, revisions, member IDs and evidence are fixtures. For a new intentional action, copy its shape, allocate one unique command ID, and bind current values:

<!-- room-code: prepare -->
```js
function prepareCommand(example, work, fields = {}) {
  const command = structuredClone(example);
  command.id = crypto.randomUUID();
  command.data = { ...command.data, ...fields, workItemId: work.id, expectedRevision: work.revision };
  return command;
}
```

Here `example` is the parsed JSON shape for the chosen action, and `actualFields` replaces any fixture content with your real evidence or finding (use `{}` for accept/start):

```js
const latest = (await client.workContext(workId)).work;
const pending = prepareCommand(example, latest, actualFields);
// Inspect pending and confirm the action is still intended before sending.
const result = await client.command(pending);
```

Keep that full object until its outcome is known. The reply is `{ sequence, event, duplicate }`; the server supplies the authenticated `event.actorId` and a new `event.id`. A command ID is **not** a completion event ID.

Every new work mutation uses the latest work `revision`, not the Room sequence or member revision. Successful mutations increment the work revision. Refetch before preparing the next action; another participant may have changed it.

### Accountable member: accept → start → complete

Acceptance and start require `accept_work`; completion requires `complete_work`. Only the assigned accountable member performs these actions. These examples handle a `mode: "read"` assignment; “read” does not disable Room record writes.

<!-- room-command: accept -->
```json
{"id":"guide-accept-1","type":"work.accepted","data":{"workItemId":"guide-work","expectedRevision":0}}
```

<!-- room-command: start -->
```json
{"id":"guide-start-1","type":"work.started","data":{"workItemId":"guide-work","expectedRevision":1}}
```

Starting records intent; it does not execute the assignment. Do the separately authorized work, then submit the actual result:

<!-- room-command: complete -->
```json
{
  "id":"guide-complete-1",
  "type":"work.completed",
  "data":{
    "workItemId":"guide-work",
    "expectedRevision":2,
    "summary":"Synthetic agenda draft; not real completed work.",
    "evidenceUrl":"https://example.invalid/agent-guide/fixture-v1.txt",
    "evidenceVersion":"synthetic-fixture-v1",
    "producerId":"author",
    "checksClaimed":["Synthetic fixture text inspected"],
    "nextAction":"Designated reviewer checks the exact artifact."
  }
}
```

Replace the fixture URL with **real, authorized HTTPS evidence** that the intended reviewer can retrieve. Use immutable content or a pinned revision and verify its bytes. Do not use signed URLs containing secrets. Compute the version from those actual bytes when using a content hash:

```js
import { createHash } from "node:crypto";
// artifactBytes is the exact Buffer that the approved evidence URL serves.
const evidenceVersion = `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;
```

The service validates HTTPS URL syntax, not reachability, artifact content, or hash correctness. A hash identifies bytes; it does not establish quality. `checksClaimed` must say only what really ran. Test fixtures are not real agent or human review evidence.

`reportedById` comes from the authenticated caller. `producerId` is a separate **reported attribution** to a known Room member, possibly someone other than that caller. Supply it only when known; omit it or use `null` when unknown. Never supply `reportedById` or `actorId` in a command. Unknown provenance cannot satisfy the independent-review requirement.

For `mode: "write"`, stop unless the operator has authorized the external work. The domain also requires `write_external` and a current claim held by the accountable member before start/completion. The existing `claim.acquired` data is `{ workItemId, expectedRevision, repository, ref, paths, expiresAt }`: exact repository/ref/path scope, nonempty `paths`, future ISO expiry. Claims record coordination, not a filesystem lock or external execution grant. Do not change the assignment to `read` to avoid a claim.

New reservations reject overlap with another active work item's scope in the same
room (`409 claim_conflict`). Repository and ref match by exact declared string:
agree on a canonical spelling; URL aliases, different refs, different rooms and
outside workers are not reconciled. Use relative file paths or `folder/**` for a
subtree (`**` for the whole repository); arbitrary globs, absolute paths and `..`
are rejected (`422 invalid_claim_scope`). Disjoint paths or agreed isolated drafts
can proceed in parallel. Do not invent a different ref merely to evade a conflict.

`orient()` includes each item's `mode` and `claim`. Read the conflict, coordinate
with its holder, and wait for confirmed release or expiry. The holder or a claim
manager may send `claim.released` with `{ workItemId, expectedRevision }`. Release
does not pause an outside process, finish work or transfer its result. Blocked or
completed work can retain its reservation; release explicitly when appropriate.
Historical events replay unchanged, so pre-existing overlaps still require human
coordination. An identical already-committed retry returns its original receipt,
not renewed authority: read current state before starting external work.

`returnBrief()` is the same deterministic, source-linked catch-up used by people.
Reading it does not acknowledge history or act on work. Its history boundary is
frozen for pagination; current work has its own evaluated-through boundary. Refresh
to include newer changes, and never turn a recommendation into implied approval.

### Separate reviewer: inspect → pass or fail

Use the designated reviewer's own credential and `verify` permission. Fetch the current receipt, retrieve only authorized evidence, compare the exact version, and perform the stated checks. In `actualFields`, bind `completionEventId` to **`latest.receipt.eventId`**, `evidenceVersion` to `latest.receipt.evidenceVersion`, and `summary` to your actual finding. If the receipt changes during review, do not attach your finding to the replacement version. For independent review the reviewer must differ from the accountable member and known producer; separate credentials alone do not prove organizational independence.

<!-- room-command: review-pass -->
```json
{
  "id":"guide-review-pass-1",
  "type":"verification.recorded",
  "data":{
    "workItemId":"guide-work",
    "expectedRevision":3,
    "result":"pass",
    "completionEventId":"fixture-completion-event",
    "evidenceVersion":"synthetic-fixture-v1",
    "summary":"Synthetic check: exact artifact names an owner and contains an agenda."
  }
}
```

<!-- room-command: review-fail -->
```json
{
  "id":"guide-review-fail-1",
  "type":"verification.recorded",
  "data":{
    "workItemId":"guide-work",
    "expectedRevision":3,
    "result":"fail",
    "completionEventId":"fixture-completion-event",
    "evidenceVersion":"synthetic-fixture-v1",
    "summary":"Synthetic finding: the draft does not name its owner.",
    "nextAction":"Add the responsible owner and submit a new artifact version."
  }
}
```

A failure blocks the work. The accountable member resolves the finding, starts again, and submits a **new** completion with fresh command ID, evidence and revision:

<!-- room-command: resolve -->
```json
{"id":"guide-resolve-1","type":"work.blocker_resolved","data":{"workItemId":"guide-work","expectedRevision":4,"resolution":"The missing-owner correction is understood; prepare a new version."}}
```

Resolving returns work to `accepted`; it is not a claim that the corrected artifact already exists. Reuse the start/complete **shapes**, not their old command IDs. A new completion clears the current review and decision; the reviewer checks that new receipt.

To report an ordinary obstacle as the accountable member, use:

<!-- room-command: block -->
```json
{"id":"guide-block-1","type":"work.blocked","data":{"workItemId":"guide-work","expectedRevision":2,"reason":"Required source context is missing.","nextAction":"Ask the owner to supply the permitted source."}}
```

If `ownerDecisionRequired` is true, a valid review pass leaves `next.action: "decide"`. **Stop there.** Only the designated human decision-maker records the decision using their own account. Completion and review are not owner approval; even approval does not perform an external action.

## Recover without duplicates

- **Lost response, timeout, or uncertain server error:** the write may already exist. Reconcile from current state/events, or resend the **identical prepared command**, including its old expected revision, evidence fields and ID. Do not call `prepareCommand` again. A duplicate returns the original event and sequence with `duplicate: true`, even though the work revision has advanced.
- **Explicit stale revision rejection:** no mutation was applied by that request. Read current state, reassess whether the action still makes sense, then deliberately prepare a new command. Never refresh revisions automatically in a retry loop.
- **Same ID, changed contents:** `409 idempotency_conflict`; recover the original intent rather than changing the ID to force a write.
- **401:** stop and ask the operator to restore access. **422:** fix the rejected shape/authority/transition, not the service rules. **429:** back off; the current service advertises 60 seconds. Reads never mark work handled or messages read.

Persist pending commands only in approved private storage: their bodies may contain Room data. Keep credentials separate. The client does not automatically retry, follow evidence links, launch an agent, or call Compute/MCP.

## Wire limits and executable examples

Commands allow only `id`, `type`, `data`, and optional `causationId` (an existing event in this Room). Do not send a full event envelope. IDs are 1–128 characters, start alphanumeric, then use alphanumerics, `_`, `.`, `:`, or `-`; reserved prototype names are rejected. Work revisions are nonnegative safe integers. Ordinary text fields are nonblank, at most 4,096 JavaScript string units; `checksClaimed` has at most 64 nonblank strings, each at most 512 units. Total serialized command/request limit: 16,384 UTF-8 bytes. Keep summaries short; link permitted evidence rather than embedding large artifacts.

The seven JSON examples are parsed by `tests/agent-write-guide.test.js` and sent through disposable real Room storage and HTTP clients. Fixture URLs under `example.invalid` are intentionally not live. The test binds content hashes to synthetic in-memory artifacts; it verifies command behavior, **not hosted evidence retrieval, real task execution, or human approval**.

```sh
node --test tests/agent-write-guide.test.js
```

For read pagination, recovery boundaries and current interoperability limits, see [Agent client contract](./AGENT-CLIENT.md).
# Private reminders (local schema-v8 candidate, not yet deployed)

`client.reminders()` reads only the calling member's personal reminders. This
does not expose a human's reminders to a separately authenticated agent. These
preferences never enter shared orientation, packets, events or read markers.

To schedule, supply exactly:

```js
const request = {
  requestId: "stable-id-for-this-intent",
  workItemId: "chosen-work-id",
  expectedRevision: 0, // No prior row; otherwise use its current reminder revision.
  action: "schedule",
  dueAt: Date.now() + 3_600_000
};
const result = await client.reminders(request);
```

Store the request before sending. After an uncertain result, resend that exact
object; do not recalculate the time or replace its ID. A response contains the
original `receipt` and a fresh `reminders` view. An old successful schedule receipt
does not mean the reminder is still active: it may have been cancelled or retired.

To remove an active reminder use `action: "cancel"`, current `expectedRevision`,
and a new stable `requestId`; omit `dueAt`. Read, review and choose a new action
after `stale_reminder`; do not automatically overwrite another edit.

One active reminder per work item, at most 100 per member/room. Schedule strictly
in the future and within 365 days. New schedules stop at 5,000 retained requests;
cancelling existing active reminders and exact retries remain available. Resolution,
supersession and access revocation retire reminders without resurrecting them on
reopen. Logout or key rotation alone does not remove them.

In-app only: there is no background agent runner, webhook, email or push delivery.
Private reminder times are preferences, not proof that work is being performed.
