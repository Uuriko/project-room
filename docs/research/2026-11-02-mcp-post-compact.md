# Optional compact hosted MCP post receipts

Base main `1b157458d`; runtime/tests `0f33ef788`. No push, merge, deployment or production calls. Only room_post_message gains optional compact:true. Omitted/false returns the original command+event object exactly; shared bond/DM command receipt helper, REST command output and SDK validators are untouched.

Compact output contractVersion1 contains status, roomId, requestId, messageId, eventId, actorId, sequence, duplicate and currentStateVerified:false. Actual server replyToId/workItemId/toMemberId references are preserved when present, as are note/mentionWarnings returned by the underlying command. It contains no command/event/body echo. These are recorded-operation facts, not fresh state or work completion. Default full receipts still satisfy the existing command.data/body contract.

compact is a strict boolean in the advertised input schema and runtime validation. It never enters the command data or idempotency fingerprint. The same exact id/body can change receipt format on retry without another event. Changed input under that id remains idempotency_conflict. Caller-held exact input recovers a consumer-discarded first result; one event and its original sequence/eventId remain. Server-minted IDs are returned after a successful call, but if that first response is entirely lost the caller cannot recover an unknown minted id: unchanged limitation, so hold an explicit id before sends that require recovery. Compact does not fabricate warnings absent from an underlying duplicate response.

Actual local HTTP hosted MCP measurements (UTF8 complete JSONRPC response, including both text and structuredContent; headers excluded):

| Input body | Default full | Compact | Reduction |
|---|---:|---:|---:|
|5B ASCII|1126B|650B|42.3%|
|1648B ASCII|7698B|650B|91.6%|

Structured value alone is479/3765B full and258B compact. Existing MCP JSON text/structured duplication remains, but it duplicates the small receipt. No shared text rendering change or production latency claim. Different IDs, warning/reference metadata or escaping can change exact sizes.

Causal original-base run:4new tests fail because compact is not accepted. Final5new cases plus existing hosted auth/core neighbors:19/19pass, zero skipped. Tests cover strict invalid booleans/unknown fields without writes; advertised schema; default false/omitted equivalence; minted IDs; exact format-toggled retry and body conflict; caller-held input after discarding a response; genuine reply/work references and unknown-mention warnings. An injected note after a real command explicitly tests optional envelope metadata, not a new server note or transaction-fault claim. Actual stored normalized message body is independently selected and compared. No auth mutation or body truncation was added.

```sh
node --test tests/mcp-post-compact.test.mjs tests/room-mcp-auth.test.js tests/mcp-core-profile.test.js
node node_modules/eslint/bin/eslint.js server/mcp-hosted-tools.mjs server/mcp-room-profile.mjs tests/mcp-post-compact.test.mjs
node scripts/secret-scan-diff.mjs --base 1b157458d
```

Lint and secret diff pass. Compressed causal/final logs and uncompressed SHA256 hashes are in audit/evidence/mcp-post-compact-20261102/receipt.json. No full-suite/Native/storage qualification is claimed for this transport-only result selector.
