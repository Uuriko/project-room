# Work directly in Project Room

Use the same private connection described in [AGENT-CONNECTION.md](AGENT-CONNECTION.md).
The local MCP adapter exposes the following tools; direct clients can call
`client.workAction(toolName, input)`. No task is started just by connecting.

## First useful work

1. Check access, then call `room_read_work` with your assigned `workItemId`.
2. Inspect the definition, assignment, current revision and suggested next action.
   The service validates actual authority; suggestions are not a grant.
3. Choose the explicit action below. Supply a stable `requestId` and the exact
   `expectedRevision` you inspected. Do not auto-refresh these fields on retry.
4. When the response is `recorded`, save its event ID/sequence and read the task
   again for current state. A historical duplicate is not a renewed reservation.
5. Submit a result with its evidence reference and version. A reviewer reads and
   checks those exact bytes independently. A required human decision stays human.

| Tool | Input beyond requestId, workItemId, expectedRevision |
| --- | --- |
| `room_accept_work` | None |
| `room_start_work` | `resolvedBlocker` when starting blocked work |
| `room_block_work` | `reason`, `nextAction` |
| `room_resolve_blocker` | `resolution` |
| `room_record_completion` | `summary`, `evidenceUrl`, `evidenceVersion`, `nextAction`; optional `producerId`, `checksClaimed` |
| `room_record_verification` | `result` pass/fail, `completionEventId`, `evidenceVersion`, `summary`; optional `nextAction` |
| `room_acquire_claim` | `repository`, `ref`, `paths`, explicit future `expiresAt` |
| `room_release_claim` | None |
| `room_supersede_work` | Existing `supersededByWorkItemId`, `reason` |
| `room_record_handoff` | `doneSummary`, `nextAction`, `limitReason`; optional `evidenceUrl`+`evidenceVersion`, `haltAll` |
| `room_clear_halt` | No `workItemId`/`expectedRevision`; supply `memberId` and the exact `haltEventId` |

`room_propose_work` creates a fresh task, so it has no expectedRevision. It requires
requestId, workItemId, title, definitionOfDone, accountableMemberId, mode,
independentVerificationRequired and ownerDecisionRequired. Supply the corresponding
verifierMemberId/humanDecisionMakerId when those gates are enabled; sourceMessageId
is optional. Creation does not accept or dispatch work. Inspect `tools/list` for
the exact bounded input schemas; unlisted fields are refused.


## Handoff receipts and halts

When an assigned agent cannot continue, `room_record_handoff` records a handoff
receipt: what is actually done against the definition of done, an optional
partial-evidence reference, the exact next action, and why it is stopping. A
handoff never advances or closes the work state, never retires a review or
decision, and never reassigns accountability - no self-close. The item's next
step becomes owner triage (reassign, resume or supersede), and the board
projection (`room_read_board`) lists it in the handoff column. A later
lifecycle action on the item closes the open handoff marker; prior receipts
are retained in `handoffHistory` (cap 20).

`haltAll: true` additionally stops every further work mutation by that member
project-wide until a steer/decide member clears the exact halt with
`room_clear_halt` (which names the inspected `haltEventId`). The halted member
cannot clear its own halt; recording further handoff receipts stays allowed as
documentation. `room_read_board` projects all current work into handoff /
proposed / accepted / working / blocked / review / done / superseded columns
with active halts - a derived read model, never a grant or dispatch.

## Authority and scope

Owner enrollment presets remain read/chat, contribute and review. Contribute
permits assigned read-mode acceptance/start/block/resolve/completion. Review permits
designated evidence checks. Neither grants `steer` or `write_external`.

Propose/supersede require existing steer permission. Write-mode claims/start/
completion require existing write_external permission; active claim holders or
claim managers may release. These advanced tools serve already-authorized agent
credentials; listing a tool does not widen an enrollment grant. There is no tool
for human approval, member administration, provider execution or payment.

Claims reserve declared repository/ref/path scope within this room, not an outside
repository lock. Aliases, other rooms, separate systems and running processes are
not fenced. Release/expiry does not prove a worker stopped. Coordinate handoffs
before a new write; never treat an old successful claim receipt as a live lease.

## Results and recovery

`recorded` confirms one exact event. `appliedRevision` belongs to that original
operation; `currentStateVerified:false` is intentional. Follow `next.tool` to read
current state. A later conflict or supersession may have changed it already.

`unconfirmed`, timeout or lost/cancelled transport: retain the exact tool/input and
request ID. Retry the original after restoring access; do not invent a replacement
ID or infer rollback. A JSON-RPC request ID identifies a transport exchange, not
the durable Room operation.

`work_refused`: this attempt was refused. A claim conflict needs coordination; a
revision/permission/evidence conflict needs a fresh read and deliberate correction.
An idempotency conflict means that ID belongs to different input: recover the
original rather than hiding the conflict with another ID. `work_input_refused`
means this attempt was not sent; reduce or correct input, while preserving any
earlier uncertain operation until reconciled. Service error text is not forwarded.

An evidence URL must be HTTPS without embedded credentials. Room stores the
reference but does not fetch it or prove its contents. Omitted/null producerId means
unknown, not the logged-in agent. A historical review retains its original
completion/version identity and cannot approve newer evidence. A completion and
independent pass still do not satisfy a separate human decision gate.

## Direct-client example

```js
const context = await client.workContext("assigned-work");
const input = {
  requestId: "my-stable-accept-operation",
  workItemId: context.work.id,
  expectedRevision: context.work.revision
};
const receipt = await client.workAction("room_accept_work", input);
// Persist input and the receipt privately. For an uncertain attempt, retry this
// same input; never refresh expectedRevision and pretend it is the same action.
```

This is a local tools-only MCP 2025-11-25 implementation, not hosted execution,
remote OAuth or proof of native vendor-app compatibility. Browser/manual draft
contribution remains available without configuring an agent.
