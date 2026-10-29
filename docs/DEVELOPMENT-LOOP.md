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
