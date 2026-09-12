# Safe diagnostics (W4-57 · M6)

Bounded operation IDs, error categories, and support exports — with no
credentials, private reasoning, or unnecessary room bodies in logs.

## Operation IDs

Every `/api/*` response carries `X-Operation-Id: op_<48 random bits>`
(`server/http.mjs`). Failed requests also echo it in the error payload as
`operationId`, so an operator can quote one short id to support instead of
pasting request details.

## Error categories

`errorCategory(httpStatus, code)` (`src/agent-error.mjs`) maps every failure
to one coarse bucket: `access`, `not_found`, `conflict`, `rate_limited`,
`unavailable`, `internal`, `input`. The category ships in the error payload
and in the server-side diagnostic record; it is the triage signal, not the
message text.

## Diagnostic records

`DiagnosticsLog` (`server/diagnostics.mjs`) keeps a bounded ring (200 per
room) of records with only operation metadata: `operationId`, `at`, `status`,
`code`, `category`, `route` (ids templated to `:item`), `roomId`. Never
request bodies, message text, member details, tokens, or hashes. The same
fields go to `console.warn` as a single line per failed room-scoped request.

## Support export

Owner-only bundle for handing to support:

```sh
node scripts/agent-inbox.mjs support-export
```

or `GET /api/rooms/:roomId/diagnostics-export` (downloads as an attachment).

The bundle (`supportExportBundle`) emits whitelisted scalars only:

```json
{
  "format": "project-room-support-export-v1",
  "exportedAt": "...",
  "service": { "sourceRevision": "...", "buildId": "...", "mode": "..." },
  "room": { "id": "...", "title": "..." },
  "diagnostics": [ { "operationId": "op_...", "at": "...", "status": 422, "code": "...", "category": "input", "route": "/api/rooms/:roomId/commands" } ]
}
```

Authority: the room owner, via room bearer (CLI) or signed-in account
session. Agent members and anonymous callers get 401/403. Verified by
`tests/support-export.test.js`, which also asserts the serialized bundle
contains no invite codes, code hashes, access keys, link tokens, or message
bodies — even when the room holds all of them — and no `token`/`hash`/
`secret`/`credential`-like keys at any depth.
