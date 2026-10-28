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

## Operational alerts (E3)

Three signals mark the service protecting itself rather than a caller's
mistake. Each is emitted through the channels above — a diagnostic record
where the event is room-scoped, and one `console.warn` line with no
credentials, bodies or driver text. No monitor is installed by this
repository (`docs/INVITE-ONLY-DEPLOYMENT.md`), so the consumer column names
the human who must confirm they read these logs before the row counts as an
alert (`docs/EXECUTION-PLAN.md`: a consumer and sustained thresholds come
before calling it alerting).

| Signal | Where it appears | Meaning and threshold | Consumer |
|---|---|---|---|
| `stream_lagging` | Diagnostic record `{ status: 200, code: "stream_lagging", category: "unavailable", route: "/api/rooms/:roomId/stream" }` plus `room diagnostic <op> 200 stream_lagging unavailable /api/rooms/:roomId/stream` | One SSE consumer buffered more than `streamQueueCap` (64 KiB by default, `createRoomServer` option) of unsent bytes. The server sends a final `event: stream_lagging`, ends only that stream, drops the socket if it has not drained within 5 s, and leaves every other stream alone; the client resumes with `Last-Event-ID`. One record per hour for a room is a slow network; a sustained rate (several per minute) means a wedged client or an undersized cap and needs a look. | owner to confirm |
| `storage_unavailable` | `503 storage_unavailable` (`Retry-After: 30`, category `unavailable`) on the refused request; diagnostic record and `room diagnostic <op> 503 storage_unavailable unavailable <route>` for room routes | `SQLITE_FULL`, `SQLITE_READONLY`, `SQLITE_IOERR`, `SQLITE_CANTOPEN`, `ENOSPC`, `EDQUOT`, `EROFS` or `EIO` reached the store (`server/store.mjs`, `isStorageUnavailable`). The failing transaction is rolled back — no event, command journal row, projection or checkpoint is written — and the driver text stays in the server-side `cause`. Any occurrence on a pilot host is actionable: check disk space, quota and file permissions on the database directory. | owner to confirm |
| Readiness flip | `room storage unavailable after N consecutive failures; readiness now 503` and `room storage recovered after a committed write; readiness now 200`; `GET /api/ready` answers `503 { "status": "unavailable", "reason": "storage_unavailable" }` while degraded | After `storageFailureThreshold` consecutive storage failures (3 by default, `RoomStore` option) readiness turns 503 so a proxy or supervisor stops routing writes; `/api/health` stays 200 because the process is alive and reads still work. Readiness recovers on the next committed write, not on a read probe, so a quiet host stays 503 until an operator or a member writes successfully. Alert on the first 503 flip; a recovery line without an operator action means the disk cleared itself and still deserves a capacity check. | owner to confirm |

Verified by `tests/storage-failure.test.js` (a real `SQLITE_FULL` from a
page-capped database: rollback, stable code, no driver text, readiness flip
and recovery) and `tests/stream-backpressure.test.js` (a raw socket that
stops reading is closed with `stream_lagging` while a reading peer keeps
receiving and the stalled client resumes from its last id).
