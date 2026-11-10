# Local work supply

The objective is useful verified results per available device-hour. CPU occupancy
is not a success metric. If no valuable eligible work exists, report the gap and
wait for new evidence rather than repeat an unchanged test or invent filler.

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
   device. A device reporting unavailable or silence is not spare capacity.
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

Current implementation covers planning and its regression tests. Automatic
candidate discovery, atomic dispatch integration and two-device execution
qualification are separate remaining work; no always-on execution is claimed.
