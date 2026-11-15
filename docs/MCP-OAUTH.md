# Room-bound OAuth file access and work paging

## Explicit file consent

Existing grants do not acquire file access. A new explicit consent request may
include `files:read` and/or `files:write`; neither scope mints spending permission.
Account and invitation/public-lobby consent show the requested file tool names
and staging cost. Ordinary room membership, guest and autonomy-tier rules remain
independent requirements. No file deletion tool is exposed by these scopes.

| Tool | Required OAuth scopes | Existing restrictions |
| --- | --- | --- |
| `room_get_file` | `files:read chat:read` | Uploader-only staging; committed message visibility, DM parties and history floor |
| `room_list_files` | `files:read chat:read` | Normalized rooms require 1–8 visible message IDs; metadata only |
| `room_put_file` | `files:write` | 5 room-cents per call, existing spend authorization and writable tier required |
| `room_commit_file` | `files:write chat:write` | Uploader attaches to their own message; no new message or byte upload |

Reuse the same attachment ID, filename, media type and exact base64 bytes after
an uncertain staging response. A matching retry returns `duplicate:true`; a
conflicting payload does not replace bytes. Reuse the exact attachment/message
pair for commit retries. Read back bytes and SHA-256 before sharing evidence.
Staging expires after 24 hours. OAuth consent never grants cross-room access,
access to someone else's staged file, or access to a hidden message.

Normalized OAuth file reads share one synchronous transaction and the existing
512-record reservation for the composed sponsorship and selected-message reads.
The 256 KiB current-context ceiling, file size limit, eight-message selection,
and protected history/visibility checks remain unchanged. This is not a global
budget change, an authorization cache, or permission to scan all room files.

## Native connector import qualification

The source of the hosted schema is `server/mcp-hosted-tools.mjs`; the local stdio
schema is `client/mcp-stdio.mjs`. Both already define optional `cursor` (string,
1–1024 characters) and `limit` (integer, 1–100, default 25). Normalized source
pages examine at most four work and four reply-request sources, so `page.limit`
may be smaller. `page.hasMore:true` can accompany an empty filtered page.
Follow `page.nextRead.arguments` unchanged until `page.hasMore:false` and
`page.nextCursor:null`. A stale cursor requires a fresh first page.

An external native connector importing only `focus`, `query`, `roomId`, and
`sort` cannot express this continuation. No importer implementation or persisted
native connector schema artifact is present in this repository. Passing the
hosted/stdio tests does **not** prove that external connector has been refreshed.

Minimal external repair and verification:

1. Refresh the existing connector's `room_list_work` input schema from the
   authenticated hosted `tools/list` response, preserving optional `cursor` and
   `limit` with the exact types/bounds above. Do not create a new identity or
   widen OAuth grants to refresh a schema.
2. Inspect the host-visible imported signature and verify both arguments exist.
3. Read a multi-page fixture with `limit:2`; submit the exact returned
   `page.nextRead.arguments`, including `cursor`, through the native connector.
4. Traverse an empty filtered page that reports more sources, and demonstrate
   termination without lost/duplicate IDs. Change the fixture's observed state,
   verify stale-cursor refusal, then restart without the cursor.
5. Record deployed server revision, connector/schema revision and exact tests.
   Until this succeeds, native import parity remains an external blocker.

Local regressions live in `tests/mcp-oauth-http.test.js`,
`tests/mcp-invite-oauth.test.js`, and `tests/mcp-native-work-parity.test.js`.
Existing file lifecycle/history tests remain in `tests/room-mcp-files.test.js`.
All fixtures are synthetic; testing does not authorize live uploads, spending,
new grants, merging or deployment.
