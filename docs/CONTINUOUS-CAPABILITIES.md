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
Multiple watcher processes share admission. Each watcher fills available slots
up to the configured job/CPU/memory limits, rotates past denied jobs and samples
resources before each claim. Shutdown cancels its children and waits for their
receipts before closing state. This is cooperative admission, not an OS resource
sandbox. The Room request watcher still owns fresh Room authorization; the local
queue watcher does not replace it.

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


## Managed desktop integration roadmap (2026-10-23)

Product target: installing Project Room installs a usable worker. The CLI above
is a development interface, not the intended onboarding requirement. Baseline
use must not require separately installed Node, copied MCP configuration,
Tailscale, Git, Xcode or a manually started daemon. Repository-specific tasks may
need additional tools; the app should acquire approved capability dependencies
or explain the missing requirement at the point of use.

Implementation order and acceptance:

1. **One managed worker:** bundle the supported runtime and baseline capability,
   use the existing owner-private state/journal and desktop lifecycle. Enrollment
   binds origin, room incarnation, member and local device; sign-out/pause stops
   new admission. Persist only explicit folder/resource grants. Desktop owns
   OS consent, install/update and diagnostics. Never infer execution authority
   from a conversation or a downloaded tool manifest.
2. **First useful job:** install, sign in, choose a folder/resource mode, submit
   one bounded verification job, inspect the result. Exercise through the actual
   app on a clean account with developer PATH/tools absent. A mocked bootstrap
   or successful CLI test is not a passing install qualification.
3. **Shared efficient execution:** use the scheduler in this package, not a new
   per-tool daemon. `watchLocalCapabilities` accepts the app's AbortSignal and
   resource observer; emits compact completion receipts. `metrics` returns
   aggregate job states, step counts/durations and artifact counts, without
   inputs or logs. Duration sums are not wall time, CPU time or tokens saved.
   Model calls and token savings remain explicitly unmeasured.
4. **Reuse:** first preserve exact-operation replay already implemented. Add
   cross-operation caches only for declared deterministic operations, keyed by
   exact input/content, package/runtime/toolchain, relevant environment and
   authorization scope. Validate artifacts and current grants before reuse.
   Do not cache deployment, payments or other side effects as computations.
5. **Placement:** fresh device/resource observations, data locality and estimated
   transfer costs choose eligible hosts. Queue/execution ownership must remain
   explicit through disconnects. Power/thermal/foreground modes adjust new
   admissions; unknown old processes retain reservations. Do not retry unknown
   side effects on another laptop.
6. **Transport:** qualify current HTTPS control and artifact relay with no
   Tailscale dependency, including resume, hash verification and private access.
   Add authenticated LAN transfer behind the same artifact contract afterward.
   Resolve the existing cloud file spend-grant policy explicitly; never hide or
   bypass the live 402 by changing identity.
7. **Capability updates:** retain immutable pins and evaluation/rollback already
   present. Add signed distribution metadata, compatibility checks, staged
   installation and atomic activation; a tool update cannot widen grants or
   modify the update trust policy. Resume old pinned work after app restart.
8. **Qualification and measurement:** two physical Macs, exact candidate heads,
   human request → authorized execution → artifact → exact-attempt decision →
   fresh authority check → result. Disconnect and restart at each boundary;
   verify no duplicate execution or crossed identity. Track cache reuse, model
   calls at model gateways, transfer bytes, resource observations, failures and
   human interruptions. Report uninstrumented external model use as unknown.

Current checkpoint implements local parallel queue dispatch and compact local
metrics. Desktop enrollment/wiring, automatic package acquisition, signed
updates, cross-job cache, multi-device placement, and clean-install physical
qualification are pending integration. The peer desktop/UI lane is separate;
consume its exact reviewed head rather than editing its shared files.

### Urgent cross-laptop integration work

Keep these in the managed-install milestone, not a separate networking product:

- App-managed enrollment/discovery: one device identity, explicit owner-approved
  membership, capabilities/runtime versions, last-seen time and revocation.
  Discovery does not authorize execution. Reconnect must distinguish a new
  device/session from the original executor.
- Shared capacity and work view: report fresh power, memory pressure, available
  slots, disk budget, queue and active attempt ownership. Show stale/offline
  explicitly. Give agents the same compact structured view without requiring
  them to navigate the human dashboard.
- Artifact transport: existing authenticated HTTPS fallback first, resumable
  hashed chunks, bounded disk spool and backpressure; authenticated direct LAN
  optimization behind the same interface. Validate two-Mac transfer with
  Tailscale absent before claiming independence. Measure useful throughput and
  resume success, not only ping latency.
- Placement/handoff: send work toward cached inputs and compatible tools. Split
  independent tests/indexing/shards; retain one owner per exact attempt. A lost
  heartbeat is not proof a process stopped. Require stop/reconciliation evidence
  before reassigning unknown execution, particularly release side effects.
- Shared cache: advertise content hashes and sizes, fetch only missing authorized
  content, verify every chunk and resulting object. Keep private scopes isolated;
  a hash match alone never grants read access. Each device controls retention.
- Urgent reliability: bound disk usage and reserve headroom before accepting
  work/transfers; collect receipts for requests that need answers and surface
  overdue requests. Diagnose worker death, missing grants and relay failure as
  actionable states instead of endlessly retrying or silently dropping work.

Physical acceptance: both enrolled laptops independently report actual job
starts and evidence; disconnect the preferred route mid-transfer, restart one
app mid-job, revoke access, and recover with intact privacy and no duplicate
execution. Compare one-laptop versus two-laptop completion time on the same
useful workload and include network/coordination overhead. A local simulation
or one busy Mac does not qualify the two-device system.

## Native first-job API

`first-job-prepare` accepts `{workspace,room,operation}` from the local app after
an explicit folder selection. The existing local policy must permit that room,
include capability `workspace-inventory`, and include the canonical folder path
in `workspaces: [...]`; it must not be paused. This API never configures policy,
starts a model, changes a rollout, or grants remote requesters access. It seals
folder path/device/inode into an immutable package and returns
`{schema:1,jobId,pin,expectedAttempt,state,next}`. Store this binding durably before
starting the job. Retrying the same operation returns the same job; changed
folder/package under that operation is refused. `next` is a UI suggestion, not
authority. A different sample requires an explicit new operation ID.

Use existing `run` or `watch` to execute. Admission rechecks the folder grant and
identity before starting; a renamed/replaced/symlink directory is not its old
grant. This is a cooperative worker, not an OS sandbox. Revoking a folder blocks
new admission; use existing cancellation/host stop to stop already running work.
The job enumerates at most 512 immediate entries, skips hidden names, does not
recurse, does not follow symlinks or read file contents, and writes a small
`workspace-summary.json`. It requires the packaged Node runtime only, not Git,
Xcode, a provider executable, a network connection or paid model calls.

`first-job-verify` accepts `{jobId,expectedAttempt,expectedPin}` and verifies a
completed, passing execution plus the actual bounded artifact bytes against its
recorded hash. Wrong attempts/pins, missing/changed artifacts and symlink paths
fail. It can run after app/database restart without executing the job again.
Success returns `qualified:true,scope:"local_worker_only"`, the compact summary,
and explicit `roomArtifactQualified:false,twoDeviceQualified:false`. This is
historical local execution evidence, not current execution authorization or a
claim of Room upload/peer connectivity. `summary.complete:false` means the entry
budget was reached, not a complete folder scan. Native UI should display that
limit and separately qualify Room artifact delivery and the second device.

### Device resource readiness

Local policy may opt into `reserveDiskBytes` (nonnegative safe integer bytes on
**the evolution state filesystem**) and `requireNormalMemoryPressure` (boolean).
Desktop onboarding should explicitly choose these settings; existing policies
remain compatible and are not silently rewritten. A required unavailable sensor
blocks admission. macOS pressure uses `kern.memorystatus_vm_pressure_level` with
a bounded read cached for at most one second. Other platforms report unsupported.
Disk headroom uses available blocks, not total free blocks or another volume.

`room-evolution readiness` returns schema 1 local admission health, fresh observed
capacity, reservations including interrupted jobs, guard settings and a reason.
It omits grants, workspace paths and job payloads. Ready is not job authorization:
package/workspace checks and shared transactional admission still run per job.
Denied jobs stay queued at attempt zero and the watcher reevaluates them; recovery
does not replay completed jobs. Reasons include `disk_headroom`,
`disk_observation_unavailable`, `memory_pressure`, and `memory_pressure_unavailable`.

These are admission guards, not filesystem quotas or OS process limits. They do
not terminate running jobs, reserve bytes for future output, monitor other
workspace volumes, or guarantee safe sustained saturation. Explicit cancellation
remains available; continuous pressure-based draining is a separate next step.

### Local and Room dispatch separation

New submissions atomically persist a `job_dispatch` row with `local` or `room`
origin. Reusing an operation cannot change its origin. The local watcher selects
only local-origin jobs, and `runJob` checks the origin again inside its claim
transaction. The Room adapter passes `dispatch: 'room'` only along its existing
request reservation and fresh grant path. This marker is routing, not a new
permission: arbitrary owner-local code can still call the local API.

Stop all older workers before upgrading a shared state directory; mixed worker
versions are not supported. Pre-upgrade queued jobs have no origin and remain
blocked (`job_dispatch_unclassified`), rather than guessing their authority.
Inspect and cancel obsolete queued jobs, then submit a fresh authorized operation.
Do not delete history or reclassify unknown running jobs. Completed-job replay
still returns the prior result without execution. Restart, mismatched origin,
legacy queued work and concurrent local watching are covered by regression tests.
