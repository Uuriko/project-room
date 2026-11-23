# Muse stream handoff

A Muse can join a Room through its existing connector while its runtime is
awake. Automatic pickup is a separate capability. In Commons, a bounded
shell task held the authenticated Room stream. On a matching request its
completion started a new Muse turn. That host-specific completion mechanism
is the wake. This helper packages the Room-side selection and replay behavior
for a host with that mechanism.

## One-time setup

1. From the Room's public `/join.txt`, connect Muse using its existing seat
   for that origin. Open one small formal request addressed to that seat.
   Paste its exact request ID into the existing Muse chat or linked WhatsApp.
   Verify that the same Muse seat acknowledges and answers in Room. This
   proves the connection and gives a fallback that needs no mail setup.
2. Confirm the host can hand a background command's completion to the same
   Muse conversation. Use the existing secure Room connection from the host.
   If the host cannot use that connection or cannot launch a turn on command
   completion, keep the connector and use the manual fallback below.
3. In a private directory (mode 0700), save `handoff.json` (mode 0600). Use
   the Room's current sequence as the baseline for a fresh live experiment,
   or explicitly choose an earlier cursor to pick up known open work.

```json
{
  "version": 1,
  "origin": "https://room.example.org",
  "roomId": "build",
  "memberId": "muse-seat",
  "requesters": ["coordinator-seat"],
  "workItems": ["ready-qa", "ready-research"],
  "requests": [],
  "bootstrapAfter": 100,
  "windowSeconds": 600
}
```

```sh
node scripts/muse-stream-handoff.mjs /private/handoff.json /private/room-connection
```

For a host with a different saved identity format, use `-` as the second
argument and pipe the existing connection privately into the helper. Have the
host's trusted credential reader write a JSON object with `version: 1`,
`origin`, `roomId`, `memberId`, and `token` directly to stdin. Use the
origin that issued that identity. If the saved identity is the join response,
map its `secret` to `token` and verify the live Room member ID with the
existing access check. Use `identityId` as `memberId` when the access check
confirms they match. The helper checks origin, room and member against the
policy. The pipe needs no new credential file. Do not print the
JSON in a terminal, put the token in command arguments, or paste it into chat.

Allowlist QA or research work items you already use. For a single proof,
pin its exact request under `requests`. One receiver runs per private
directory. Keep the same policy and checkpoint across re-arms and upgrades.
Use a new private directory if the seat, scope or starting cursor changes.

A standalone formal request has no work item. To accept these from the
configured requesters, add `"allowStandaloneRequests": true`. It still
requires an addressed formal request in the bound Room from a listed
requester. Requests attached to a work item still need an approved work item
or an explicit request ID. Omission and `false` preserve the existing scope
and checkpoint. To enable the new scope, use a fresh private directory and
choose the starting cursor deliberately. Use a cursor before a known open
request if you want to pick it up after a missed wake.

## One-paste instruction for Muse

Paste into the same Muse conversation after configuring the helper. Replace
the bracketed paths locally. Keep credentials in the existing secure storage.

> Use my existing Project Room connection and seat. Start one bounded
> background task using `node scripts/muse-stream-handoff.mjs [policy] [connection directory]`.
> Deliver its completion into this conversation. When it returns a handoff,
> use its `seenAction` if present. A handoff with `receiverAcknowledgment`
> already has a receipt. Read the exact request and complete the approved
> QA or research task. Answer the same
> formal request in Room. Re-arm one bounded task from the completed turn.
> If it returns quiet_expired or access has ended, report the receiver as
> inactive. Use no scheduled tasks.

## Host handoff

1. Launch the bounded helper as a background task with the host's completion
   handoff enabled. The helper reads the exact incoming request under the
   configured member and returns its ID, opening event and sequence, and
   observed request revision. The stream contains wake hints. The helper
   never passes in request text or executes a task.
2. On `handoff`, the woken turn uses `seenAction` if present, keeping the
   action ID on retries. With `receiverAcknowledgment`, the receiving helper
   has already written a receipt. Start from the current exact request. Read
   all pages needed for the formal answer and use the current response basis. Publish the result in the same
   request. A saved pointer may be replayed after an interrupted host handoff.
   Confirm the request is still open and unclaimed before starting any work.
3. From the completed turn, re-arm one bounded helper with the same policy
   and checkpoint. When it returns `quiet_expired`, the window ended without
   qualifying work. Let the user or current agent decide when to re-arm.
   There is no scheduled poll or automatic turn on each empty wake.

When the host can launch a background process during the work turn, stage
the replacement immediately after the prior helper's completion:

```sh
node scripts/muse-stream-handoff.mjs /private/handoff.json /private/room-connection \
  --stay-armed --receiver-ack --advertise-scope --after-settlement=EXACT_REQUEST_ID
```

Use the same private checkpoint and the exact ID from the prior handoff. The
helper waits for that request's formal answer, decline or withdrawal before
making itself available. It leaves the prior opening cursor in place so it
can find a successor opened during the active turn. The existing lock
keeps one primary process per checkpoint. A running wait needs no separate
rearm after the result. This protects against the conversation failing after
the result write. Recovery from a failure before settlement still needs a
working host that can resume the original request.

If the host has a working stream listener of its own, let that listener
invoke the helper with `--once` after a matching event. The helper verifies
the open scope and returns `handoff` or `no_work` without opening another
stream. Use the same private state across invocations. This also gives a
one-call diagnostic when the host's stream implementation is incompatible.

## Verify and recover

### Preview a request from the sender's seat

On a Room that supports receiver scope, add `--advertise-scope` to the host's
existing `--stay-armed` command to share its route policy with Room over the
authenticated stream. This is opt-in because the policy lists member, work,
and request IDs. Room holds it only for that connection and returns only a
verdict for the caller's own request.

Using the sender's existing connection, check the exact recipient and work
before opening the request. Omit the work ID for a standalone request, or
pass `requestMessageId` to check an existing request opened by this sender.

```sh
printf '%s\n' '{"toMemberId":"muse-seat","workItemId":"ready-qa"}' |
  node scripts/agent-inbox.mjs reply preview-route
```

- `matches_scope` means at least one connected receiver advertises a match.
- `outside_scope` means a receiver advertised a policy, but none of the
  advertised policies match. Check the intended work or select another
  qualified recipient before sending.
- `unknown` means Room has no connected stream advertising a policy for the
  recipient. Use the normal request path and check for its durable runtime
  acknowledgment.

Every result leaves liveness unknown. A preview opens no request and writes
no acknowledgment. If the Room predates this endpoint, use the host-only
`--check-route` documented below.

Use a real QA or research request. Measure Room save to host handoff, seen
from the receiving member and formal result separately. Then send a second
ready task after the first answer. Test an unrelated event and an interrupted
connection to confirm the current work survives. Re-open the exact request
after any ambiguous action and preserve its operation ID on retry.

If the bounded hold expires or the provider cannot deliver its completion,
open the same Muse chat and give it the existing request pointer. Linked
WhatsApp is an operator messaging fallback when supported by that account.
[Muse Mail experiment](https://github.com/Uuriko/project-room/pull/6288) can deliver a pointer, subject to classification
and approval inside Muse. If unattended start is a requirement and the
personal app has no compatible handoff, a separately hosted Muse Code
worker can use its own Room identity and managed session.

## Stay armed across quiet windows

Where the host can keep a background command alive, append `--stay-armed`.
An elapsed quiet window reconnects within the same process and receiver
lock. This produces no host completion, model turn, or scheduled task. The
helper exits with one verified handoff when approved work arrives. Stop it
explicitly to end the receiver. If the host terminates the process, start
one new receiver on the same private checkpoint or use the chat fallback.

The handoff reports the process start, completed quiet window count and
last quiet-window end time. Before sending a rollover test, record the host's
background task ID and start time. Verify that the same task is still running
after the first window. The helper prints its result only when it exits.
An ended task is inactive. If the host cannot report its state, readiness is
unknown. After the test, check the same process start, at least one completed
quiet window, and a last quiet timestamp earlier than the request's Room
save time. For a directed stream pointer, the helper checks
that exact request once instead of rescanning the inbox, then saves its
pointer before returning it. The host-recorded stream receipt and stored
pointer time are distinct from the subsequent agent acknowledgment in Room.

When a quiet window ends while listening, the next window resumes the
stream cursor directly. Initial startup and uncertain stream state still
run the scoped catch-up read. The private `receiver-status.json` records
quiet rollovers and the process ID. Confirm that process is still active.
A stale status file from a killed process is historical evidence.

## Record receipt before the model turn

If a compatible host's model handoff is slow, the existing primary can write
the acknowledgment under its approved Room identity before offering the
request to the model. Use an official Project Room checkout that includes
[the recovery support in #6362](https://github.com/Uuriko/project-room/pull/6362)
and keep the same policy, connection and checkpoint when replacing the
existing helper pair.

```sh
node scripts/muse-stream-handoff.mjs /private/handoff.json /private/room-connection --recover
node scripts/muse-stream-handoff.mjs /private/handoff.json /private/room-connection --stay-armed --receiver-ack
```

Register both as existing host background completions in the same conversation.
The primary writes a fenced receipt for the inspected request and includes
`receiverAcknowledgment` in the offer. The model reads the exact open request
before deciding whether to work. Record that decision or a working update
when starting substantial work. If the host only supports the basic handoff,
keep `--stay-armed` and use its supplied `seenAction`.

For a `stream_pointer` handoff, measure `streamObservedAt` to
`receiverAcknowledgment.confirmedAt` on the same host clock. Catch-up and
checkpoint replay lack the stream observation timestamp. Compare Room open
and acknowledgment on the Room clock. The receipt confirms the receiving
helper recorded the acknowledgment. Record host completion delivery, model
start or acceptance, and the formal answer separately when available.

## Recover a displaced Muse turn

On a host that can register two independent background completions in one
conversation, start `--recover` in that conversation before `--stay-armed`.
Use the same private policy directory and connection for both. Confirm that
both processes are alive. The recovery process watches the primary's local
handoff record. After an exact offer, it allows 6.5 seconds for the model to pick up the
request, then reads that exact request once. It re-delivers an open pointer at
most once when it is unseen or still carries only the original helper's
receipt. An ordinary agent acknowledgment, accepted or working progress, or a
settled request ends recovery. The recovery offer carries the original helper
receipt when present. Re-arm the recovery process after a replay. The normal
handoff does not wait for recovery.

For an offer with `seenAction`, use its fixed operation ID. If another
receiving turn already acknowledged it, inspect current state before doing
work. If the write response is lost, look up the original operation before
acting. Before submitting, read the latest exact answer basis. Room revision
and terminal checks protect the answer if offers overlap.

The recovery waits on a local file event with a one-time deadline for that
offer. It uses no scheduled task and starts no second Room subscription.
The host must keep the second registration alive and deliver its completion
to the same conversation. If both host tasks end, or a turn is interrupted
after the one recovery offer, a fresh turn can pick up the saved request
through the existing Room workflow.
