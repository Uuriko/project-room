# Local structured client contract

Version 1 · Single configured Room and service · Local pilot, not universal interoperability

Start with [Agent writes: one assignment, one receipt](./AGENT-WRITE-GUIDE.md) for a complete, tested onboarding path: read an assignment, accept/start, post exact-version evidence, review, and recover a lost response. Requires Node 24.19+.

## Use

For saved setup and a metadata-only identity check, start with
[Use your own agent](AGENT-CONNECTION.md). One private connection is shared by
reads, local MCP and optional watching. The owner can issue managed access through
People & agents; this is not a hosted AI runtime. `checkConnection({ signal })` requires a configured
`memberId`, verifies that exact agent and returns access metadata, not presence.

An operator provisions an agent membership and access key through the existing local administration flow. This document does not authorize provisioning on a live service. Keep the key in the process environment or a secret manager, never in URLs, committed files, tool descriptions, or command arguments.

Set `ROOM_AGENT_ORIGIN`, `ROOM_AGENT_ROOM`, and `ROOM_AGENT_TOKEN` for a permitted local process, then run:

```sh
npm run --silent agent:inbox -- orient
npm run --silent agent:inbox -- work WORK_ID --include-source
npm run --silent agent:inbox -- discussion WORK_ID --limit 20
npm run --silent agent:inbox -- brief
npm run --silent agent:inbox -- changes 0
```

These operations only read. Output contains permitted Room data and should be treated as private. The command does not start an AI, accept work, acknowledge reading, or perform external actions.

For opt-in continuous or one-shot assignment notifications, see [Watch your
assignments](./ASSIGNMENT-WATCHER.md). The local foreground watcher has its own
durable checkpoint, exact-ID pending output, explicit stop and bounded retries.
It uses the same current next-step model and never launches work or advances the
human caught-up marker. It is not a hosted agent runtime or historical event replay.

For programmatic use, import `RoomAgentClient` from `client/room-agent.mjs` and instantiate it with `{ origin, roomId, token }`, adding `memberId` to pin an agent. Pinned operations check current identity before the actual request; snapshot/selected-work/catch-up responses must also match the viewer. All operations target that fixed origin and Room. HTTPS is required except for isolated loopback development. Redirects are rejected, browser cookies are omitted, and each request has a 15-second timeout.

`snapshot({ signal })`, `workContext(id, { includeSource, signal })` and `changes(after, limit, { signal })` accept optional read
cancellation. `RoomClientError.retryAfterMs` exposes parsed retry timing or `null`;
the client itself does not retry reads or writes automatically.

## Operations

| Client method | Result and boundary |
| --- | --- |
| `orient()` | Contract version, authenticated member, Room scope/permissions, evaluated-through sequence, bounded-pilot work records and their next steps. It is a description, not permission to dispatch. |
| `snapshot()` | Current authorized Room projection, recent event tail and viewer ownership. Room membership currently grants Room-wide context; this is not task-level privacy. |
| `workDiscussion(id, { since, cursor, limit, signal })` | One bounded source/linked-draft/reply page, exact attribution, frozen continuation and separate current work. No reactions, unrelated threads or read-marker changes. Use since **or** cursor; no automatic pagination. [Discussion and recovery contract](WORK-DISCUSSION.md). |
| `workContext(id, options)` | One authenticated task read: current roles, claim, blocker, evidence, next actor and suggested Room actions, with a shared revision/evaluation boundary. Source excluded by default; `{ includeSource: true }` adds only its exact linked message. No fetches or writes. Local candidate, not yet live; see [selected-task contract](./WORK-CONTEXT.md). |
| `workDefinition(id, { signal })` | Reads selected context once and returns only title/done criteria for deliberate reuse. No source text or write. Choose new people and review flags explicitly; read permission does not grant creation. [Reuse contract](./WORK-REUSE.md). Local candidate, not yet live. |
| `resultDraft(id, { signal })` | Reads selected context once, returning only title/reported summary for deliberate editing. No source, identities, structured evidence links or authority metadata returned. Not automatic redaction, verified authorship or publication. [Result-copy contract](./RESULT-COPY.md). Local candidate, not yet live. |
| `changes(after, limit)` | Durable event page, next cursor, and has-more flag. Page limit 1–100. Advance a processing checkpoint only after your application handles the page. |
| `returnBrief(options)` | Frozen-horizon change history and live work needing attention. Pass the returned continuation tuple unchanged for subsequent pages. Fetching does not mark anything read. |
| `command(command)` | Explicit write through the existing service command boundary; success includes persisted event/sequence and duplicate status. The client does not grant additional capabilities. |
| `workAction(name, args, { signal })` | Ten named lifecycle actions shared with MCP, using a pinned `memberId`, strict inputs and exact receipt matching. Returns the original operation receipt, not current ownership. Explicitly read current work afterward. No automatic retry, rebase, claim renewal or permission expansion. [Action guide](AGENT-WORK-LIFECYCLE.md). |

Read shapes: `orient().work` and `snapshot().state.messages` are arrays; `snapshot().state.workItems` and `.members` are ID-keyed objects. Resolve a source with `snapshot.state.messages.find(message => message.id === work.sourceMessageId)`, not object indexing. `next.memberId` identifies the member currently addressed; it is not necessarily the producer or reporter.

For a known work ID, prefer `workContext()` over downloading the room and joining
its messages manually. `context.work` is one object and `context.context.source`
reports `not_requested`, `not_linked`, `unavailable` or `included`. Suggestions are
not a promise that a command will succeed; scope conflicts and all authority checks
remain enforced by the service. This private read is not the narrower portable packet.

Orientation work entries include IDs, definition of done, source-message reference, state/revision, current receipt, review, decision and blocker. `next` contains `action`, `label`, `memberId`, `role`, `needsAttention`, `workItemId`, `workRevision`, `completionEventId`, and `evidenceVersion`. The evaluation sequence shows when that description was true. Re-read current state before acting on stale work; the service validates revisions regardless of the client's description.

The current orientation scans the existing pilot's capped work collection; it is not a scalable or selectively paginated agent inbox. Context clipping, work-level grants, runtime identities, budgets and wake controls need a later reviewed runtime integration. Do not expose this local pilot as a public agent service.

## Explicit writes and recovery

### First contribution: a draft

After checking access and reading one work item, prepare one stable command. No
implementation-file reading is needed. This requires only read-and-chat access:

```js
const context = await client.workContext("selected-work-id");
const command = {
  id: "my-agent-draft-request-01", // Keep this exact command for uncertain retries.
  type: "message.posted",
  data: {
    messageId: "my-agent-draft-message-01", // Unique within the room.
    workItemId: context.work.id,
    packetId: "my-agent-handoff-01", // Your stable correlation ID, not a key.
    basisRevision: context.work.revision,
    body: "Your actual draft for human review."
  }
};
const receipt = await client.command(command);
// On an unknown outcome, replay this identical object—not new IDs.
```

Choose your IDs once per intended contribution. A draft does not accept/start or
complete the task, grant claims, approve evidence, or advance a caught-up marker.
If the task changed, reread and review before revising the request. Only explicit
consent to submit against an older revision should add `allowOlderBasis: true`.
That is changed input, not an exact retry. For strict receipt matching use
`confirmsWorkReturn(receipt, command, roomId, memberId)` from `src/workflow.js`.

Read back with `workDiscussion()` and explicitly follow any continuation, matching
the exact receipt event/message ID, author and bytes. Use `workContext()` to confirm
work remains unchanged. Neither read advances the caught-up marker.

A command has a caller-owned stable `id`, an allowed `type`, and `data`. The service attributes the actor from the credential. Mutations include the expected work revision; review and decisions identify the exact completion event and evidence version. [The write guide](./AGENT-WRITE-GUIDE.md) contains command shapes and recovery rules; its JSON examples run through the real store/client in `tests/agent-write-guide.test.js`. Reading server or test implementation is not required to start.

On a lost response or timeout, the write outcome is unknown. Reconcile from permitted current state/events or resend the exact same command object with the same ID. Do not automatically replace its ID or replay an external effect. A changed command needs a deliberate new ID and fresh revision. HTTP errors preserve the service status and code; stale revisions need refresh, revoked access needs operator intervention, and rate limits require backoff. The client does not automatically retry or override those decisions.

## Interoperability boundary

The browser, return brief, direct client and local MCP adapter share canonical
service state and authorization. [Local MCP and host setup](AGENT-HOSTS.md) covers
the tools-only 2025-11-25 adapter. Protocol harnesses and two actual agent routes
have been exercised locally. Native vendor applications, remote MCP/OAuth, hosted
runtime execution and provider connectors remain separate unverified milestones.
