# Laptop work through Project Room

This candidate lets agents discover a willing laptop, submit a typed request,
and receive a compact result after ordinary local programs do the work. Both
laptops connect outward over HTTPS. Neither SSH nor Tailscale is required by
these modules. Server installation, client installation and a two-physical-Mac
qualification are separate from passing the local integration tests.

## Agent workflow

1. Run `node scripts/room-native-worker.mjs discover CONNECTION_DIRECTORY`.
   The directory lists only current advertisements willing to accept this
   identity. It includes supported adapters, named recipes, available admission
   slots, maximum input size and expiry. Availability is not a reservation.
2. Choose an existing recipe or ask the operator to install a reviewed local
   recipe. A request never supplies executable paths, arguments or shell code.
3. Prepare an input artifact and a task JSON file. Submit with
   `node scripts/room-native-worker.mjs submit CONNECTION TASK_JSON OPERATION_ID DISPATCH_DIRECTORY`.
   The private dispatch journal pins the chosen recipient and exact request
   before transmission. Reuse the same operation ID, task and journal after an
   uncertain response. Never create a replacement job to recover an old one.
4. The laptop performs the configured steps without asking an agent to invoke
   each command. Results return through the existing reply-request mechanism.
   Success receipts contain hashes and observed exits; logs stay on disk and
   the result artifact. Failure stops dependent steps and includes a focused
   handback question. Agents inspect detailed evidence only when needed.

Good initial recipes include tests followed by a build, data validation followed
by a report, indexing, checksums, conversion and scripted browser checks. Local
modules may call installed tools. An agent should use ordinary code for
predictable work and reserve model calls for interpretation, repair and decisions.
The runtime does not itself call a model. Arbitrary pinned modules are trusted
local code, so their model use is reported as `not_measured`, not asserted zero.

## Local grant and worker

Use an existing private Room connection directory. Create an owner-controlled
grant JSON outside the repository. Example (replace identities, origin and
expiry; permissions are not inferred from these placeholders):

```json
{
  "version": 1,
  "origin": "https://room.example",
  "roomId": "team",
  "memberId": "laptop-agent",
  "requesters": ["planning-agent"],
  "adapters": ["sha256-v1", "json-summary-v1", "node-test-v1", "recipe-v1"],
  "maxInputBytes": 1073741824,
  "timeoutMs": 120000,
  "maxConcurrentJobs": 1,
  "paused": false,
  "expiresAt": 0,
  "recipes": []
}
```

Start with `node scripts/room-native-worker.mjs watch CONNECTION GRANT STATE`.
Use `run CONNECTION GRANT STATE REQUEST_ID` for one explicit request and
`status STATE` for local execution status. The watcher advertises capabilities
and checks incoming typed requests; normal chat does not execute. It requires
the new laptop directory routes. Set `paused: true` to stop new admission.
Terminate the worker to interrupt its running process group. Expired grants
refuse new work. Saved result delivery still rechecks current Room access.

Each worker currently admits one job at a time. Different laptops can run
concurrently; a recipe can parallelize internally using `ROOM_TASK_CPU_SLOTS`.
The owner may choose a resource policy with `mode` (`balanced` or `idle-heavy`),
`maxJobs`, `memoryPerJobBytes`, `reserveMemoryBytes`, `reserveDiskBytes`,
`allowBattery` and optional `paused`. For example, reserve 4 GiB memory and
10 GiB disk, budget 2 GiB per parallel step and permit up to 8 slots on AC.
`resources STATE POLICY_JSON` shows measured headroom and the resulting budget.
CPU load, free memory, free disk and power gate admission; stale/unknown signals
are not permission to consume capacity. These are admission budgets, not kernel
CPU or memory limits. Interactive-user detection and thermal throttling are not
implemented in this candidate. Heavy mode must be explicitly configured.

## Recipes

A local recipe has `version: 1`, an `id` and up to 16 sequential `steps`. Each
step has `id`, absolute `module`, its exact `sha256`, local `args`, and
`timeoutMs`. Modules execute using the installed Node runtime, in a private
per-attempt directory, with no inherited Room token or general shell environment.
They receive `ROOM_TASK_INPUT`, `ROOM_TASK_OUTPUT` and `ROOM_TASK_CPU_SLOTS`.
Modules can share intermediate files through their common working directory.

Every module is checked before admission and again before execution. Timeout,
cancellation or output overflow kills the process group. stdout/stderr are
retained locally with hashes; success receipts omit their bodies. A nonzero exit
stops the recipe and asks for agent judgment. A module hash does not pin its
transitive dependencies or prove that it is safe. This is trusted host code,
not an OS sandbox: use existing VM isolation for untrusted source execution.

`node-test-v1` uses a local grant's `nodeTest: {path, sha256}`. `sha256-v1` and
`json-summary-v1` are built in and do not execute received code. JSON summaries
retain a 4 MiB parsing cap; use a streaming recipe for larger datasets.

## Files and limits

Small artifacts reuse Room's existing authenticated attachments. Uploads use
stable chunk IDs, commit only to a selected sender-owned message, and preserve
its visibility. Downloads reauthorize cached chunks and verify all hashes.
The existing attachment size, room quota, retention and priced-operation rules
still apply. This path does not waive a spend grant.

Large artifacts stay on laptop disks. The new `laptop-transfers` route carries
one 512 KiB chunk per transfer, with at most 16 active sessions and two per
sender per server store. The total decoded relay buffer is at most 8 MiB. Room
does not store these bytes in its attachment table, event log or database.
The protocol ceiling is 64 GiB per file; the client defaults to 1 GiB, adjustable
through its `maxBytes` API option and the receiving worker's local grant.
The 64 GiB ceiling is validation, not a claim that a 64 GiB transfer was tested.

Sender command:

```text
node scripts/room-native-worker.mjs serve CONNECTION FILE TRANSFER_ID RECIPIENT REFERENCE_JSON
```

Send the small reference to the recipient, who runs:

```text
node scripts/room-native-worker.mjs receive CONNECTION REFERENCE_JSON PRIVATE_CACHE
```

The task's `input` can also contain this laptop reference. The receiver writes
and fsyncs each chunk, journals its hash, checks checkpoints on restart and
verifies the whole file before exposing it. A source change fails final
verification. The sender must remain available; the laptop is not a permanent
always-on storage service. Relay sessions expire after two minutes without use.
After relay eviction, re-offer the same transfer and resume the same checkpoint.
After a process restart, reuse the reference and original file with
`serveLaptopArtifact`; the CLI's initial `serve` refuses to overwrite an existing
reference file. Transfers use HTTPS; no separate end-to-end encryption is added.

## Request contract and recovery

The request body starts with `Project Room task v1` and a newline, then JSON:
`{version:1, adapter, input, inputSha256, expectedResultSha256}`. A `recipe-v1`
request also supplies `recipeId`. Additional command-like fields are rejected.
`expectedResultSha256: null` permits execution but does not claim independent
result acceptance. Exact deterministic expected output hashes can be checked
automatically. Successful script exits and content correctness remain distinct.

The existing SQLite request journal and server reservation remain authoritative.
Input download precedes execution intent. A durable result is saved before
output upload; interrupted uploads resume from that result, not by executing
again. Lost reply acknowledgements retry the original saved response. Changed
request revisions stop reconciliation. A crash with no durable result stays
unknown and requires inspection. An admission lock left by an abrupt process
death is not automatically stolen: inspect the old process and attempt first.

## Qualification

This remains a pilot, not an unattended fleet release. The watch loop does not
automatically reconcile `needs_attention` attempts; use the explicit `run`
command to deliver a validated saved result. Abrupt process death can leave
the admission lock requiring inspection. Advertisements are not refreshed while
a long job is executing, so that worker can disappear from discovery until the
job returns. File transfer uses fixed polling; independent loopback tests found
the default polling interval materially limits throughput. Bounded long polling,
long-job presence and restart recovery need qualification before broad rollout.

Run the affected tests and repository gates. Local tests exercise authenticated
Room HTTP, artifact visibility, resumable upload/download, 10 MiB laptop transfer,
receiver restart, request acknowledgement loss, local grants, module pins,
timeouts, recipe handback and stale-capability rejection. They do not prove a
physical Wi-Fi transition or installation on the second Mac.

Before retiring Tailscale, deploy the CI-qualified server, install the exact
client on both Macs, configure grants and independently verify a two-Mac task
and large-file round trip with Tailscale unavailable. Repeat with interrupted
network, worker restart and cancelled/revoked work. Retain failures and receipts.
Measure elapsed time and agent/model calls for equivalent accepted jobs; no
token-saving percentage or throughput improvement is claimed without that data.
