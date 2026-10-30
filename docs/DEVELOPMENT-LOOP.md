# Browser failure to a reproducible work request

This bridge connects an existing failure packet to Room work and one addressed
reply request. It neither runs a host nor accepts, starts, completes, reviews,
approves or deploys work. Use the existing [failure importer](../scripts/browser-failure-work.mjs)
and [reproduction host](BROWSER-REPRODUCTION-HOST.md) for those separate observations.

Create a private configuration JSON with `origin`, `roomId`, `memberId` (the
submitting agent), `recipientId`, `failureId`, `checkout` (the importer source
checkout) and `sourceRoot` (the original JUnit producer checkout path). Add
`existingWorkItemId` when this failure belongs to already tracked work. The
recipient must match the packet's accountable member. Do not put credentials in
this file. Preview re-runs the importer against the original receipt, JUnit and
Git source; an edited packet or invented failed test is refused.

```sh
node scripts/development-loop.mjs preview packet.json config.json original-receipt.json junit.xml new-plan.json
```

The new plan is created exclusively, never overwritten. Inspect its source,
chosen test, recipient, work proposal and request text. It contains no executable
command. Its IDs are stable; retain the exact plan for retries. This is unsigned
local evidence, not an attestation of CI execution.

With the existing saved agent connection (`ROOM_AGENT_CONFIG`), explicitly submit:

```sh
node scripts/development-loop.mjs submit new-plan.json
```

Creating work requires the existing `steer` permission; the bridge grants none.
New work retains the importer's proposal policy. Existing work is read before
sending and must have the selected accountable member. A new proposal is followed
by a current work read; the addressed request is followed by its own readback.
If a response is lost, retry the exact plan. Room's command receipts reconcile
the same IDs, including a work proposal that succeeded before the request failed.
Do not edit an unknown operation or substitute another recipient on retry.

The laptop operator chooses an existing host and fixed local command profile.
For an enrolled, configured native Codex host, select just this requester and
request using the existing receiver:

```sh
ROOM_AGENT_CONFIG=/absolute/saved-connection node scripts/run-codex-room.mjs --watch-requests /absolute/journal.sqlite /absolute/runtime.json REQUESTER_ID REQUEST_ID
```

The runtime profile must already be configured for the native host and permit
the operator-selected reproduction command. The request alone does not start a
host, install tools or authorize broader execution. Keep the journal and dedicated
Codex home for recovery. The generic `scripts/run-room-request.mjs` command host
is Linux/bubblewrap-only; it is not a macOS fallback. The reproduction adapter's
operator-local mode itself is not an OS sandbox.

The production request journal already persists intent before execution, saves
the answer before delivery and retries that answer without running the host
again. An intent without a saved result is ambiguous and requires reconciliation.
A definite stale/refused answer is not silently rebased. Reading or answering a
request is separate from work lifecycle transitions.

For the reproduction receipt, bind `packetId` to the chosen failure ID,
`packetSha256` to the plan's packet digest, and `workItemId` and `requestMessageId`
to the plan. Preserve the receipt and exact `stdout.tap` privately. Link them:

```sh
node scripts/development-loop.mjs link new-plan.json receipt.json stdout.tap
node scripts/development-loop.mjs link new-plan.json receipt.json stdout.tap release-record.json
```

The report checks source, test, IDs and output digest. It does not fetch evidence,
change Room state or establish producer authenticity. A release record may name a
different revision in the same repository; that is only a reference, with the
fix relationship explicitly unproven. Even a passing reproduction establishes
neither a fix nor deployment. Use the existing exact-version result/review flow
and [release record](RELEASE-RECORD.md) for their respective evidence.

The integration test uses a committed synthetic Node assertion failure, actual
JUnit, a loopback Room HTTP server, the real subprocess adapter and SQLite request
journal. It proves the connected data/retry path, not a browser interaction or a
two-laptop execution. Retain actual Chromium and peer-host observations separately.

For one explicit handoff, the native host can finish without leaving a watcher
running:

```sh
node scripts/run-codex-room.mjs --capabilities
node scripts/run-codex-room.mjs --preflight /absolute/runtime.json
ROOM_AGENT_CONFIG=/absolute/room.json node scripts/run-codex-room.mjs --run-request /absolute/journal.sqlite /absolute/runtime.json REQUESTER_ID REQUEST_ID
```

Capabilities describe installed code, not current authentication or availability.
Preflight checks the dedicated profile without a model turn. `--run-request`
selects exactly one requester and one addressed request; its `request_selection`
event records the operator's choice, not acceptance of linked work. The runner
then revalidates Room access, records execution intent, and automatically returns
the saved answer through the existing reply API. The final `delivered` event
includes the request ID and receipt. Other queued requests are untouched.

After sleep, process interruption or a lost acknowledgement, rerun the same
command with the same journal. A saved answer is redelivered with its original
operation ID without starting Codex, even if that backend is unavailable. An
intent without a saved answer remains unknown and refuses reexecution; inspect
and reconcile it rather than deleting the journal or changing IDs. Errors exit
nonzero with an unconfirmed-delivery event. The command does not install a wake
service, reconnect a physically sleeping laptop, or claim that every interrupted
execution can be recovered automatically. Local tests simulate a lost reply
acknowledgement and reopen the SQLite journal; physical sleep remains a separate
host qualification.

## Local test execution through existing Room requests

The integration target is one shared work lifecycle, not a second machine work
board. Room owns request identity, revision, reservation and result delivery.
The operator-owned machine owns execution admission, subprocesses and evidence.
An agent's Room membership does not grant access to its owner's computer.
Hosted agents can participate without contributing a local worker.

`client/local-test-executor.mjs` supplies a fixed test executor to the existing
`runRequestOnce` journal. It uses the existing bounded `hostSubprocess` without
model calls. This explicitly selected operator-local mode is not an OS sandbox
and does not broaden the generic Linux/bubblewrap host. Only reviewed, pinned
repository tests are appropriate. Untrusted Room prose never selects a command,
checkout, executable, test, seed, output path or environment variable.

Create existing private evidence and journal directories. Save a local profile:

```json
{
  "mode": "operator-local-tests",
  "checkout": "/canonical/reviewed/checkout",
  "revision": "FULL_40_CHARACTER_COMMIT",
  "tree": "FULL_40_CHARACTER_TREE",
  "node": "/canonical/path/to/node",
  "git": "/canonical/path/to/git",
  "outputRoot": "/canonical/private/evidence",
  "requesterId": "EXPLICITLY_ALLOWED_REQUESTER",
  "suites": ["tests/events-kernel.property.test.js", "tests/spend-grants-property.test.js"],
  "seed": 10300000,
  "timeoutMs": 120000
}
```

The machine owner selects that profile and one addressed reply request:

```sh
ROOM_AGENT_CONFIG=/absolute/private/connection-directory \
  node scripts/run-local-test-request.mjs REQUEST_ID \
  /absolute/private/request-journal.sqlite /absolute/private/test-profile.json
```

Room's existing request context is revalidated and the current attempt reserved
before execution. The source must remain clean at its pinned commit/tree. The
receipt binds request/attempt/revision, tool file digests, target Node binary,
selected tests and exact retained stdout. Target source and executor code are
separate identities; dependency contents remain unattested. Test failures are
returned as failed observations. Skips remain visible, and zero-test or cancelled
runs cannot become a passing observation. Successful test delivery is not a work
approval, a release, or proof that a remote native agent performed work.

The existing journal saves the answer before delivery. Retry with the same
journal and request after losing an acknowledgment: the saved answer is delivered
without starting a second subprocess, even if the original executor disappeared.
An interrupted attempt with no saved answer remains unknown and requires
reconciliation. Do not import the spare-test queue's automatic rerun behavior
into this shared request path. No automatic pickup, new server schema, dashboard,
launch agent, or secret-bearing peer synchronization is introduced here.

### Consolidation sequence and evidence required

1. **Qualify the executor:** real loopback Room request plus actual Node child;
   assert one execution after lost response, reject dirty source and unapproved
   requester, preserve failure/skip/unknown outcomes.
2. **Qualify both machines:** install the same reviewed executor, pin the target
   candidate separately, record Node differences and disjoint seeds. Send one
   actual addressed Room request, observe reservation/result and independently
   inspect the receipt. Do not equate a delivered setup message with execution.
3. **Connect existing admission:** use current host/requester policy, work
   priority, pause and wake mechanisms. Foreground assigned work outranks
   explicitly authorized spare-capacity batches. Heartbeats indicate liveness;
   they are not proof of useful progress or exclusive ownership.
4. **Integrate lifecycle and UI:** one supported local runtime launched by the
   desktop app or headless CLI; login startup must honor persistent pause and
   avoid restart loops after failure. The human sees one result/progress summary
   per batch; detailed machine attempts remain inspectable. Agent operations use
   the same request/result APIs, not UI automation.
5. **Retire duplication:** only after real disconnect, restart, cancellation and
   stale-request qualification, retire parallel dispatch code. Retain local seed
   allocation and evidence storage as executor internals. Do not create a second
   shared scheduler or repeat per-seed updates in Room.

Research informing these boundaries: [Buildkite agents](https://buildkite.com/docs/agent)
separate local job execution and artifact reporting from dispatch;
[priority](https://buildkite.com/docs/pipelines/configure/workflows/job-priority)
is evaluated before dispatch. [Temporal activity recovery](https://docs.temporal.io/tasks)
separates worker attempts and checkpoint information from shared workflow state;
retries still require operation-specific idempotency. These are design references,
not added dependencies. Existing Project Room contracts remain the implementation
starting point; the wider resource-network direction remains conditional in
`FOCUSED-DELIVERY-PLAN.md`.
