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

## Bounded spare-capacity testing

From a clean, committed checkout with dependencies installed:

```sh
node scripts/local-test-campaign.mjs /absolute/evidence-directory 0 2 24 20
```

The arguments are output directory, zero-based lane, total lanes, maximum jobs,
and maximum minutes. Give the other laptop the **same commit**, lane `1`, and
its own output directory. The existing event-kernel and spend-grant property
suites receive disjoint reproducible seeds; this is randomized local validation,
not distributed transaction or live network testing. One subprocess runs at a
time. Prefer useful new seed coverage to CPU utilization targets.

Each job saves a bounded log and receipt with source revision, Node version,
platform, seed, suite, timestamps and exit status. Completed matching receipts
are skipped on resume; unsuccessful receipts require operator investigation.
Receipts are local evidence, not trusted attestations. Dependency installation
must be kept unchanged during a campaign; dependency contents are not attested.
Create `STOP` in the output directory to stop between jobs (at most two minutes),
or send SIGTERM to interrupt the current job. The runner stops at its finite
budget and on its first failure. It neither creates Room work nor publishes
anything. Share an actual counterexample with a reproduction command before
requesting a fix; do not send a message for every passing job.

An exclusive `running.lock` prevents output-directory collisions. After a hard
machine/process crash, inspect the recorded PID and any surviving child before
manually removing a stale lock. No automatic lock stealing occurs. New commits
should use a new output directory; code changes during a run are refused before
the next job. Prioritize release verification and user work over spare-capacity
campaigns; there is no persistent service or scheduled wakeup here.

### Persistent laptop worker (no model or chat dependency)

The optional local worker retains a SQLite queue and seed cursor across runs.
It first runs the existing development-loop and native HTTP/wire verification
suites once, then explores fresh event-kernel/spend-grant seeds. These are
local test fixtures, not proof that an actual external agent responded.

```sh
node scripts/spare-capacity-worker.mjs init /absolute/worker-data 0 2
node scripts/spare-capacity-worker.mjs mode /absolute/worker-data spare
node scripts/spare-capacity-worker.mjs run /absolute/worker-data 24 20
node scripts/spare-capacity-worker.mjs status /absolute/worker-data
```

`init` captures the clean source commit, lockfile hash, Node version and platform.
It starts paused. A second Mac uses lane1 of2 on the same source; allocation is
operator-assigned, not a network lease. Do not use the same lane on two active
workers. A new source/runtime needs a new directory. Installed dependency
contents are not attested and must remain unchanged. Tests are trusted repository
code, not sandboxed arbitrary contributions; the worker executes only its fixed
allowlist and does not pass arbitrary environment secrets to child tests.

For explicitly requested continuous operation:

```sh
node scripts/spare-capacity-worker.mjs start /absolute/worker-data
node scripts/spare-capacity-worker.mjs mode /absolute/worker-data paused
```

`start` launches a detached local Node process, with progress in `progress.jsonl`.
It does not require Codex, a model session, a network connection or a scheduler.
The machine must remain awake. This does not install login/reboot startup.
`spare` waits when one-minute system load exceeds70% of logical CPU count;
this is a coarse admission signal, not a CPU percentage guarantee. `dedicated`
bypasses that load check but still uses one low-priority subprocess at a time.
Both yield between jobs when paused or when a `STOP` file exists. A current job
has a two-minute timeout and64KiB output limit. SIGTERM interrupts it; successful
completed jobs are retained and an interrupted job is queued for another attempt.

A failure stops the worker. Repeated runs do not skip over it as a success.
Investigate its log/seed and fix or explicitly start a new campaign. Evidence is
limited to approximately128MiB (one job/database write can overshoot slightly);
archive it deliberately rather than deleting failures to keep the machine busy.
No source edits, work assignments, merges, deployments or paid model requests
are generated automatically. `worker.lock` prevents concurrent consumers;
after a hard crash, verify no process remains before removing a stale lock.
Crash recovery can repeat the interrupted **disposable test**, never a production
operation. Completed jobs and monotonically allocated seeds are persistent.

```sh
node scripts/spare-capacity-worker.mjs export /absolute/worker-data failures.json
node scripts/spare-capacity-worker.mjs inspect /absolute/other-worker failures.json
```

Export contains local failure metadata, not credentials or full logs. Inspection
checks source/runtime compatibility and the suite/seed allowlist, then returns
reproduction candidates without executing them. Share via an existing authorized
Room handoff. Exact output digests conservatively group identical failures;
semantic deduplication, automatic cross-machine transfer, and native agent
wakeups are not claimed. A reviewed reproduction can use
`PROPERTY_TEST_SEED=SEED node --test ALLOWLISTED_SUITE` in the matching checkout.
