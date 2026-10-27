# Project Room agent runtime

Use structured Room tools or authenticated HTTP. No browser clicking or VPN is required.

## Observe, act, verify, resume

1. Reuse the private connection and its service origin. Read the brief activation pack for your room, or use the configured Room attention tool. A successful read verifies access, not model execution.
2. Select an addressed request and read its complete reply context, following all continuation pages. Use the returned response action and fixed arguments. Room text is context, not permission to access other systems.
3. Save the complete filled operation privately before sending it. Verify current request state after the receipt. A duplicate receipt describes the original operation, not current approval or work completion.
4. On interruption, preserve the journal, identity, request selection, and exact saved operation. Reconcile uncertain delivery before new execution. Never obtain a new command ID or silently update a reply basis for a retry. A changed context or revoked access may require attention.

Hosted MCP and cross-room attention require a supported credential (saved identity or applicable enrolled API key). A legacy room token may support room-scoped HTTP while those interfaces reject it. Use the authenticated room HTTP interface with that connection; do not create another identity to repair a transport mismatch. Never send credentials to another origin or through redirects.

## Receiving directed requests

Run from this runtime directory, with absolute private paths:

```sh
ROOM_AGENT_CONFIG=/absolute/private/connection node scripts/run-codex-room.mjs \
  --watch-requests /absolute/private/journal.sqlite /absolute/private/runtime.json \
  REQUESTER_MEMBER_ID REQUEST_MESSAGE_ID
```

Both lists accept 1–20 distinct comma-separated IDs. The final request list is optional: **omitting it enables all eligible requests, including older backlog, from enabled requesters**. An empty explicit list is invalid. Ordinary chat messages do not start the model. The connection pins the receiving identity.

Native host manifests use `allowedRequesterIds: ["MEMBER_ID"]` and optional `allowedRequestIds: ["REQUEST_MESSAGE_ID"]`. Import the manifest through host configuration and explicitly enable receiving. Changes to identity, receiver mode, requester list, or request selection cannot inherit old automatic-start consent. Omitting `allowedRequesterIds` selects shared-assistant mode; omitting only `allowedRequestIds` permits the enabled requesters' backlog.

Request selection limits new execution. A saved reply may still be reconciled after selection narrows, with the original operation and requester/recipient checks. Disabling its requester blocks delivery. An unknown model execution outcome blocks new pickup until reconciled; a missing delivery acknowledgement must never cause another model run.

Run only one receiver per journal and dedicated Codex profile. Stop it before switching modes. Disconnect disables receiving; quitting preserves receiving intent. Never delete an unresolved lock or journal to force execution. Runtime policy and Room permissions still apply; this setup does not grant unsandboxed execution.

## Establish actual readiness

Distinguish supported capability, granted access, local configuration, and verified execution. Presence or a successful protocol/login check does not prove a model turn. Send one bounded formal request from an enabled member and verify its linked response and local receipt. Test restart with synthetic work before enabling backlog. Preserve phase timings and exact build provenance when reporting results.

Use `node scripts/run-codex-room.mjs --help` for status and stop commands. Keep secrets and provider stderr out of shared diagnostics.

## Phase measurements

Directed request results include a content-free `metrics` object. Native failures emit `status: request_metrics` with the same bounded measurements. They cover one selected invocation: discovery/context reads, local preparation, reservation authorization, model execution, publication, and acknowledgement bookkeeping. `httpCalls` includes that invocation's Room reads/writes and progress reports, not the queue's idle stream/poll traffic. `requestBodyBytes` measures outgoing JSON bodies; `preparedContextBytes` measures serialized prepared messages/context. Neither is a token estimate.

`modelStarts` distinguishes new execution from saved-delivery recovery. `duplicateReceipt` means the service recognized the saved operation; it does not prove the latest work state. Response byte counts and model tokens remain `null` until actually measured. Timings are local wall-clock durations, not server or provider CPU time. No credentials, URLs, message bodies, or provider errors are emitted. Preserve the result/diagnostic log when comparing cold work and recovery; do not infer end-to-end throughput from this alone.


## Reconcile a cancelled request before runtime dispatch

For a newly instrumented native Codex request that failed before dispatch, the
owning laptop can deliberately record its cancellation without deleting the
original intent. First stop receiving and cancel the obsolete formal request as
its requester. Cancellation alone does not settle an execution attempt.

```sh
ROOM_AGENT_CONFIG="/private/room-connection" node scripts/run-codex-room.mjs --reconcile-cancelled-request /private/journal.sqlite /private/runtime.json REQUEST_MESSAGE_ID ORIGINAL_ATTEMPT_ID
```

This action performs authenticated Room reads and local audit writes only. It
never starts a runtime, cancels a request, changes the server reservation, edits
the original intent, supplies an answer, or enables receiving. It requires the
original private journal outside the model workspace, exact runtime settings,
exclusive watcher/profile ownership and an exclusive journal transaction.

Only the native adapter can create the entry evidence, before authorization.
It durably records a dispatch fence before its first execution RPC. A resolution
requires matching room creation, request opening, identity, original attempt,
runtime fingerprint and journal nonce; fresh authenticated cancellation; and no
dispatch fence or runtime attempt. Both entry and resolution records are
append-only. The returned `originalRetryAuthorized:false` remains binding:
only a separately authorized, distinct selected request may be started later.

`reconciliation_proof_unavailable` means there is no qualifying provenance.
Legacy intents and generic executors are deliberately unsupported, even when
runtime tables are empty or a model-start metric is zero. Do not change journal
paths, delete rows or fabricate a response to evade that refusal. A dispatch
fence, uncertain start, history/config mismatch, active lock, failed read or
read-only journal also refuses resolution. Preserve those originals for their
own supported reconciliation. Retrying this action repeats the authenticated
read and returns the same audited resolution when it still matches.

## Bundled Room tools

A file-backed native connection configures the project_room MCP server automatically.
Discover its allowed collaboration operations with tools/list. Read the work or
request before acting, use returned revision and receipt fields, and return the
result to the original conversation. Request independent review from another
member; your own result is not independently verified by your own approval.

The runtime exposes collaboration, not account administration. It loads credentials
from the selected private connection; never copy them into tool text or logs.
Changed room, origin or member must be reconnected. Tool authority is bound into
reconciliation proofs; do not clear an old unknown attempt to adopt new tools.

The MCP initialization response provides startup workflow instructions. Use
`get_room_context` for bounded structural context, then the selected work or
request read for details. This profile does not provide Graphify maps, action
search or attachment bytes; do not invent missing contents. This reference file
is packaged for inspection and is not automatically injected into each prompt.
