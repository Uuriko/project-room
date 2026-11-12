# Local work supply

The objective is useful verified results per available device-hour. CPU occupancy
is not a success metric. If no valuable eligible work exists, report the gap and
wait for new evidence rather than repeat an unchanged test or invent filler.

## One-shot deterministic verification

An authorized local process can run affected unit checks without an agent loop:

```sh
node scripts/verify-local.mjs --checkout /absolute/clean/checkout --head <40-character-head-sha> --base <40-character-base-sha> --recipe affected-unit
```

This reuses `ci-affected.mjs` and `unit-ci.mjs`. It requires a clean repository
root (including untracked files), serializes jobs per checkout, and checks the
source again after execution. The default timeout is 30 minutes; process-group
cancellation currently supports macOS/Linux, not Windows. Existing unknown
reservations must be reconciled manually; the command never steals them.

The command prints the status and an atomic receipt path under the checkout's
Git directory. Receipts retain source/base, lockfile and test-plan hashes,
Node/platform/architecture, timing, exit status and copied artifact hashes.
Output stays local and may contain test data; no credentials are deliberately
forwarded to the child, and no artifacts are uploaded. Existing PATH/HOME are
retained for local tooling. This is not a sandbox: run only authorized source.

`passed` means the affected selection passed on this machine, not full CI or
hosted approval. Missing evidence, changed source and interrupted execution are
invalid. Dependencies and transient edits between source checks are not attested.
No automatic cache reuse, claims, scheduler, listener or GitHub status is created.
Dispatch through the existing runner/native process tools after obtaining the
required ownership; this command is the deterministic payload, not a second runner.

### Deliver a deterministic result through an existing request

The existing request runner accepts a locally configured verification host:

```json
{
  "kind": "local-verification",
  "binding": {
    "origin": "https://room.trydemigod.com",
    "roomId": "your-room",
    "memberId": "existing-member",
    "requestMessageId": "existing-request",
    "requestRevision": 0
  },
  "verification": {
    "checkout": "/absolute/clean/checkout",
    "expectedHead": "<40-character-head-sha>",
    "baseSha": "<40-character-base-sha>",
    "recipe": "affected-unit",
    "timeoutMs": 1800000
  }
}
```

Keep this configuration local. Reuse the saved connection via `ROOM_AGENT_CONFIG`
(the private connection directory); do not copy credentials into the recipe.
Use the actual request revision from its complete selected context:

```sh
node scripts/run-room-request.mjs --check /absolute/recipe.json
node scripts/run-room-request.mjs existing-request /absolute/private-journal.sqlite /absolute/recipe.json
```

`--check` validates configuration and platform support, not source readiness or
Room permission. The payload checks the clean source immediately before running.
The host pins origin, room, member, request ID and revision; message bodies cannot
select code or override its recipe. This mode is one-shot: `--auto` is refused.
Only macOS/Linux process-group cancellation is supported. The existing runner
owns the service claim, heartbeat and durable response journal. `runPlannedRequest`
can use the same host as its configured `execute` function; bind the selected job
revision to `verification.expectedHead` in local operator configuration.

The reply includes status, source/base, selection hash/count, platform, timing and
local receipt ID/digest. Logs, local checkout paths and raw test errors stay local.
A failed check is an answered request requiring investigation; it does not mark
linked work complete. A temporary delivery failure retries the saved response
without invoking the recipe again. Interruptions preserve local evidence, but an
aborted runner may retain an unknown attempt requiring reconciliation. Retain
both the journal and receipt; never delete them to force an unchanged rerun.

Qualification includes an actual Room fixture service, SQLite journal, real Node
test subprocess, failed checks, delivery failure/recovery, and the existing CLI.
This is not proof of unattended production dispatch or an idle session wake.

`node scripts/plan-local-work.mjs snapshot.json` ranks an operator-supplied
snapshot and emits an advisory plan. It does not discover devices, claim work,
start models, execute shell commands, or enable background operation.

## Work supply loop

1. Discover bounded candidates from changed PR heads, newly failed CI jobs,
   unresolved MVP acceptance checks and explicitly selected maintenance work.
   Each candidate needs a source revision, concrete acceptance criterion, reason
   it matters, required capabilities, estimated cost and conflict scopes.
2. Reconcile outcomes first. A saved response awaiting delivery is recovery work;
   an unknown attempt must not become a new run. Keep its reservation until the
   existing runner resolves it. Record completed work only with evidence.
3. Obtain a fresh report from each device: stable device fingerprint, runtime,
   capabilities, availability and active work. Two chats on one machine are one
   device. A fresh verified unavailable report blocks every alias of that physical
   fingerprint until reconciled. A device reporting unavailable or silence is not spare capacity.
4. Plan up to two queued tasks per available device, one executing at a time.
   Prefer high expected value per minute. Scope overlaps serialize onto the same
   device or wait. A failed job requires an investigation candidate, not endless
   retries of the unchanged source. Prerequisites require verified receipts.
5. Before dispatch, re-read the selected Room request/work and acquire its current
   claim/run ownership through the existing service. Plans are not leases. Use
   `client/request-runner.mjs` and its private journal; do not add a second watcher
   or copy another runtime's credentials. Only the configured host executes work.
6. Verify acceptance against the exact source revision, attach evidence, release
   ownership, and refill. Replanning after source changes does not invalidate an
   unresolved earlier attempt or permit concurrent conflicting writes.

The existing runner's `--auto` mode can pick up addressed requests sequentially
when explicitly configured and enabled. This planner does not activate it.
Host setup, access and service claims remain required. Do not announce two live
workers based on two suggested assignments.

## Snapshot fields

- `devices`: `id`, locally verified `fingerprint` (16–64 lowercase hex characters),
  `verified`, `available`, ISO `observedAt`, and `capabilities` strings.
- `jobs`: unique `id`, `source`, `revision`, `acceptance`, `valueReason`, `value`
  (positive, at most 10), `minutes` (positive, at most 120), `requires`,
  `dependencies` (`source@revision` keys), and nonempty `scopes`.
- `receipts`: `source`, `revision`, `status: "verified"`, `evidence` reference.
- `reservations`: `deviceId`, `source`, `revision`, nonempty `scopes`. Include
  active and unknown attempts even when their nominal lease expired.
- Optional `depth` is 1–3; `freshnessMs` defaults to 120000. The CLI uses the
  current clock unless `now` is supplied for a reproducible historical replay.

Scopes use a canonical repository prefix and slash-delimited resource paths,
for example `project-room/client/request-runner.mjs`. A directory scope conflicts
with its descendants. Use separate scopes only for genuinely independent work.
Snapshot contents are metadata, never credentials or executable commands.

## Measurement

Record useful verified outcomes, time from eligibility to pickup, pending age,
verified outcomes per available device-hour, repeat executions at unchanged
revisions, duplicate side effects, failed acceptance and human rescue events.
Keep unknown availability separate from observed idle time. Compare similar jobs;
value/cost estimates are ordering inputs, not measured productivity gains.

Current implementation covers planning, selected-PR discovery and an adapter to
the existing atomic request runner. Production host configuration and two-device
execution qualification remain; no always-on execution is claimed.

## Live supply and dispatch adapter

`node scripts/discover-local-work.mjs /absolute/policies.json` reads selected PRs
through the operator's existing `gh` connection. Each policy includes
`repository`, positive integer `number`, `kind` (`review` or `failed_ci`), plus
acceptance, valueReason, value, minutes, requires and scopes from the job schema.
It uses argument arrays, never PR-supplied shell commands. Closed PRs are excluded;
failed-CI policies require an actual completed CheckRun failure or a StatusContext
FAILURE/ERROR; pending external statuses do not qualify. Skipped checks do not
create failures or prove execution. The result contains jobs and dated source
observations. Merge these with fresh devices, receipts and reservations before
planning. Review scope is explicitly selected; scanning unrelated repositories
or inventing maintenance is not automatic.

`runPlannedRequest` selects the first job for one device, requires an explicit
source/head/device → formal request/revision binding, and calls the existing
`runRequestOnce`. Its preflight refreshes planning before new execution. Request
revision changes, device staleness, changed heads and new reservations block
pickup. The service runner retains atomic request ownership, pagination,
durable unknown-attempt fencing and saved-response recovery. The caller supplies
its existing private journal, connection and configured host. Recovery of a
previous attempt belongs to that existing runner; do not recreate a job to retry
an unknown outcome. A plan itself never reserves cross-device write scopes:
existing Room work claims must cover writes before a host edits.

The adapter does not install a daemon. The subprocess backend's platform
readiness still applies (Linux isolation is not assumed available on macOS).
On these Macs, Codex scheduled chats perform the local work using their supported
tools and coordinate claims through Room. The second Mac must confirm its own
scheduled worker; shared Room membership does not prove a running host.

Qualification covers a real local Room service and SQLite journal: selected
request → claim → host result → recorded reply → retry without a second host
invocation. This fixture is not proof of production unattended execution.
