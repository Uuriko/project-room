# Continuous capabilities: local execution pilot

This is an additive local capability service and Room request adapter. It does
not replace the desktop host, production scheduler or existing agent interface.
The local owner can use the CLI now; a hosted message cannot install code,
change resource policy, promote a version or grant itself access.

## What works

- Immutable content-addressed packages with copied declared files and an exact
  Node runtime version. Packages are checked before each step.
- Durable SQLite jobs, step receipts, event cursors and per-room operation IDs.
  Retrying an operation with different inputs fails; replay uses the original pin.
- One admission database across rooms. Concurrent clients transact through
  SQLite; running and unknown executions retain CPU/memory reservations.
- Explicit room/capability policy; per-origin/member/requester grants for Room
  execution. Existing Room request preparation, server reservation and exact
  response basis remain in charge of request delivery.
- Structured agent responses with package hash, job ID and result digest.
  Logs and generated artifacts remain on the executing laptop.
- Pausing new admission, cancellation of active process groups, scoped feedback,
  event inspection, and explicit reconciliation of unknown executions.
- Candidate evaluation from two or more distinct paired job inputs. Artifact
  equivalence gates activation, deterministic percentage routing and promotion.
  Existing queued/running jobs retain their versions. Rollback changes new work.
- A repository package: exact commit checkout, configured Node tests, an HTML
  verification preview and JSON release evidence. It does not merge or deploy.

## Local entry point

Use `node scripts/room-evolution.mjs --help`. Commands take one JSON file and
return JSON. The default state directory is
`~/Library/Application Support/Project Room/evolution`, private to the OS user.
All room clients on a device must use that same broker. An explicit
`ROOM_EVOLUTION_DIRECTORY` override is for isolated tests or separate trust
boundaries; two directories do not coordinate resources with each other.

Configure with:

```json
{
  "rooms": ["my-room"],
  "capabilities": ["repository-verify"],
  "maxJobs": 1,
  "cpuSlots": 2,
  "memoryBytes": 1073741824,
  "reserveMemoryBytes": 536870912,
  "paused": false,
  "roomGrants": []
}
```

`install-repository` takes `repository` (an owner-selected local Git checkout),
`tests` (explicit relative Node test filenames), optional `version` and optional
`memoryBytes`. It returns the immutable package hash. Bootstrap with `activate`:
`{capability, hash, expectedRevision:0, bootstrap:true, reason}`.
This explicit initial activation is a trust decision, not evaluation evidence.

`submit` takes `{room, operation, capability, input}`. For repository verification,
input is exactly `{revision: "<full 40-character commit>"}`. `run` takes `{jobId}`.
`watch` drains queued local jobs without an agent; it is a foreground process
that exits on SIGTERM/SIGINT. No background service is implicitly installed.
Multiple watcher processes share admission; each watcher runs one job at a time.

`status` shows policy, activations and the most recent 100 jobs. `job` reads the
full durable record. `events` takes `{after,limit}` (up to 500), returns ordered
items and the next cursor; persist the cursor after consuming the page. Repeated
pages are safe to inspect. Notifications are not automatically sent.

`feedback` takes `{jobId,category,note}`. Categories: correct, incorrect, slow,
interruptions, other. Feedback is scoped to that job and does not silently
change preferences. `cancel` takes `{jobId}`; a request to cancel does not itself
prove that execution has stopped. Inspect the terminal job state.

## Room adapter

A local policy may add a `roomGrants` entry:
`{origin,room,member,requesters:[...],capabilities:[...]}`. Room authentication
and local grant checks both apply. Credentials stay in the existing private
connection directory and are not passed to child processes.

A reply request addressed to the worker starts with:

```text
Project Room capability v1
{"version":1,"capability":"repository-verify","input":{"revision":"<40-character SHA>"}}
```

Invoke `room-run` with `{connectionDirectory,requestMessageId}` using a saved
standard connection. Ordinary chat, extra command fields, different recipients
and ungranted requesters are rejected. The first local submission pins the
package; later activation does not rebind it. The existing request runner saves
and retries exact responses after lost acknowledgement without another job run.
A separately persisted Room binding also reconstructs an answer after local
completion but before response persistence, only while the exact original
request basis still matches. Changed or closed requests require reconciliation.

`room-watch` takes `{connectionDirectory,intervalMs}` and runs the same adapter
on incoming authorized capability requests. It uses Room event subscription with
bounded polling fallback, persists the event cursor, and re-reads standing
requests after restart. A maximum of 50 request contexts is inspected per cycle;
a rotating checkpoint prevents unrelated chat requests from starving later work.
Ordinary messages never execute. Repeated identical waiting errors are quiet.
The watcher creates no follow-up tasks or model calls. SIGTERM/SIGINT stops it;
run it under the existing host supervisor for restart-on-exit behavior.

The adapter can also be invoked by the existing host after its normal wake and access
checks. This pilot does not alter that peer-owned runtime or auto-register a
second listener. Local artifact paths are not exposed as remotely usable URLs;
the compact reply explicitly identifies evidence as local to the laptop.

## Native stop and status integration

`room-host` runs the same capability watcher under the existing native
WatchJournal and host-status protocol. Input includes `connectionDirectory`,
absolute `journal`, `expectedScope: {origin, roomId, memberId}`, and optional
`intervalMs`. Scope must match the saved connection before a service starts.
Use a dedicated capability journal; a second owner of that journal is refused.
The existing native stop operation cancels the watcher and records a confirmed
stop only after it returns. Unexpected exits and failures record recovery pending.
Credentials are never written to status receipts. Model protocol status remains
unverified: a running capability host is not proof of an active model session.

This command starts a foreground process; it does not install a daemon or launch
an AI. Run it under an explicitly configured local supervisor for restart behavior.
It reuses native status/stop without changing the Codex runtime or human UI.

## Updating a capability

`install` takes `{root,manifest}`. Manifest:

```json
{
  "schema": 1,
  "capability": "example",
  "version": "v1",
  "runtime": "<exact process.version>",
  "resources": {"cpu":1,"memoryBytes":67108864},
  "files": [{"path":"run.mjs","sha256":"<file SHA256>"}],
  "steps": [{"id":"run","module":"run.mjs","args":[],"timeoutMs":30000}]
}
```

Trusted modules receive `ROOM_TASK_INPUT` (JSON file), `ROOM_TASK_OUTPUT`
(artifact directory) and `ROOM_TASK_CPU_SLOTS`. Each step has bounded stdout,
stderr and wall time. Declared file bytes are copied into the package store;
editing the source directory no longer edits an installed package.

For evaluation, submit candidate jobs with `candidateHash` through the local CLI
only. `evaluate` takes `{capability,baseline,candidate,pairs}`, where each pair
has `baselineJob` and `candidateJob`. Jobs must have finished on those exact
versions with identical inputs in the same room. At least two distinct inputs
are required. The evaluator compares artifact paths/content hashes/byte counts;
it records elapsed time without claiming an improvement.

`activate` requires the exact current `expectedRevision`, a reason and optional
`percent`. Values 1–99 establish a canary; 100 promotes; 0 disables the canary.
Job IDs deterministically select a bucket, so duplicate submissions cannot fish
for a different version. `rollback` takes `{capability,expectedRevision,reason}`
and returns to the prior promoted version, or cancels an active canary. Already
pinned jobs and external effects are not undone.

## Recovery and trust boundaries

A stale heartbeat is not proof that a process stopped. A crashed executor leaves
its reservation occupied. After inspecting and stopping the original process
group, `reconcile` takes `{jobId,owner,attempt,processesStopped:true,reason}`.
The exact owner/attempt prevents a stale reconciliation from freeing a newer
attempt. It moves work to needs_attention and never silently reruns it.

This is owner-trusted local code, not an OS sandbox. A package hash pins declared
files, not undeclared imports, external tools or the entire host environment.
The repository recipe pins the Git revision and Node version; dependencies must
already be supplied appropriately for the selected tests. Arbitrary received
source must use the existing isolation facilities before execution. Neither
artifact equivalence nor a successful exit proves semantic correctness.

CPU/memory are admission reservations, not kernel limits. Current observation is
CPU/load and free memory. Power, thermal state, foreground responsiveness and
storage pressure are not yet integrated. Low free memory can conservatively
queue work even when macOS might reclaim caches. The broker does not coordinate
with software that bypasses it. Unknown jobs intentionally reduce availability.

No model is called by the broker. Trusted modules may call models; their usage
is reported as not instrumented. Do not infer a token-saving percentage.

## Qualification and remaining integration

`node --test tests/evolution.test.js` covers duplicate operations, concurrent
room admission, process death, cancellation, stale ownership, version pins,
promotion/rollback, corrupt bytes, mismatched artifacts, feedback and a real
local Room HTTP request whose acknowledgement is deliberately lost.

`node scripts/evolution-pilot.mjs <new-private-directory>` runs five jobs against
two Git revisions, compares two package versions, promotes through a canary and
finishes an older pinned job. It writes `report.json`, HTML previews and release
evidence. This is a local fixture, not physical two-laptop qualification.

Remaining before an unattended fleet release:

1. Supervise room-watch from the desktop/host runtime under its existing lane;
   publish capabilities and artifact references through the production transport.
2. Integrate resource telemetry and one shared broker for all laptop services.
3. Add human activity/control views over the same commands and event cursor.
4. Add capability-specific correctness/performance evaluators, workload coverage,
   promotion budgets and cooldowns. Artifact equality is only the first evaluator.
5. Qualify two physical laptops, sleep/network transitions, revocation during
   work, changed request basis, interrupted artifact publication and recovery.
6. Add desired-state controllers for indexing, previews and maintenance; agent
   improvement proposals must use the same evaluated activation path.
7. Merge only after exact-head required CI and serialize deployment with the
   peer. Native updates and data migrations remain explicit component releases.

### Shared interactions and Room evidence

`client/evolution/interaction-contract.mjs` is a framework-independent contract for questions,
operation-bound approval conversations, and results. Its snapshot/reducer exports
work in browser and Node. Scope includes service origin, room creation event,
viewer and authorization revision. Every item additionally carries operation ID,
attempt ID and package hash. Partial snapshots cannot replace state; obsolete
attempts and conflicting source revisions are refused. A validated envelope is
not permission to execute. Authorization revisions must come from the consuming
adapter's current authority context, never from untrusted message text.

`client/evolution/interactions.mjs` prepares and persists typed formal reply
requests before sending. `prepareRoomInteraction(connection, value)` fills the
deterministic request/source ID; `openRoomInteraction` additionally requires the
source work request's `sourceRequestMessageId` to check room incarnation.
Retries keep the same command and body. `readRoomInteraction` requires the current
scope and attempt, reads complete authenticated context, checks original content,
responder and expiry, and returns `executionAuthorized:false`. Approval answers
have exactly `{decision:"approve"|"decline",attemptId,operationDigest}`. Ordinary
"yes" text is not a machine approval. The CLI exposes `interaction-open` and
`interaction-read` with a private `connectionDirectory`. Human UI rendering and
runtime authorization must consume this contract before interactive execution is
enabled; this adapter does not enable Codex interactive RPCs.

`room-publish` takes `connectionDirectory`, `jobId`, `requestMessageId`,
`roomCreatedEventId` and `messageId`. It publishes a terminal job's verified
artifacts onto an existing message authored by that agent. Existing Room file
limits and spend grants apply (currently 1 MiB per file, at most 32 files and
8 MiB per publication). Oversized sets are refused, not silently truncated.
Private message visibility is enforced by the server. The publisher verifies
local hashes, refuses symlinks/path escapes, uses deterministic attachment IDs,
reconciles staged/committed records, then verifies downloaded bytes. It never
runs a job. An interrupted publication may be partial; retry the same binding.

With local policy `publishArtifacts:true`, capability execution saves evidence
intent before delivering its answer. `room-watch`/`room-host` drain the durable
outbox even after the original request is answered, publishing and announcing
verified evidence with stable command IDs. Without that opt-in, execution keeps
its existing laptop-only evidence behavior. Failed deliveries rotate through a
bounded batch and retain their intent. The announcement lists at most eight
files with an explicit continuation; the local receipt records the whole set.
No new service, blob store, spend grant or background daemon is provisioned.

Qualification includes disposable HTTP server tests for lost upload/commit and
announcement responses, process-state reopening, private visibility, revoked
credentials, stale attempts/scopes, mutated bytes, and durable exact-operation
answers. These are local fault tests, not proof of physical two-Mac failover.
The remaining release qualification is human UI consumption, runtime-specific
approval authority validation, and a two-laptop disconnect/restart run against
the exact candidate revision. Keep interactive execution disabled until those
checks pass.
