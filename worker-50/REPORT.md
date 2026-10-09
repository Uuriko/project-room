# WORKER 50 — shard report

- **Shard:** block index 49 (0-based) of `if (url.pathname …)` dispatch blocks in
  `server/http.mjs` (89 blocks total) → **`GET`/`HEAD /api/guest-agent-links`**
  (line 2416; returns `guestAgentLinkContract()`). The task's `app.(get|…)`
  pattern matches 0 handlers in this codebase (routes are pathname-dispatch
  blocks), so the shard was taken as the 50th dispatch block.
- **Method:** booted the room server in-process (`createRoomServer` +
  `createAcceptanceFixture`, same pattern as the guild smoke test) and ran
  37 request cases: fetch-based (methods, query abuse, path-normalization
  edge cases) + raw-socket (TRACE, CONNECT, GET-with-body, chunked GET,
  malformed lines, unterminated headers).
- **Result: CLEAN — no crash, no hang, no wrong status on this shard.**
  - GET → 200 with the contract body (`mint: "owner_issued"`, `kind: "agent"`).
  - HEAD → 200, correct `Content-Length` of the GET body, empty payload.
  - Wrong methods (PUT/DELETE/PATCH/OPTIONS/PROPFIND/TRACE) → 404 `not_found`
    JSON; TRACE does not echo (no XST). CONNECT → server closes the socket
    with no response (Node `connect` event unhandled; no hang).
  - Trailing slash → 200 (intentional: up-front normalization, http.mjs:948).
  - GET with body / chunked GET → 200, no hang; malformed targets → 400/404;
    8 KB query, 4 KB path → handled, no 5xx anywhere.

## Observations (info only, no bug filed, no test written)

1. Wrong-method answers 404 rather than 405. Sibling routes in the same file
   (`/api/public/rooms/directory` http.mjs:1729, `/api/opportunities.json`
   http.mjs:1829) explicitly `reject(405)`; `/api/guest-agent-links` falls
   through to the generic 404. Server-wide fallthrough convention, not a
   crash/hang/wrong-status — flagged for the guild integrator, not fixed.
2. Unterminated headers (client sends partial headers, never terminates):
   no server response within 20 s despite `headersTimeout=10000` /
   `requestTimeout=15000`. This is a cross-cutting transport behavior already
   recorded by the coordinator's batch (target 46, `raw:no-headers-terminator`,
   verdict "hang") — **duplicate, not re-reported**.
3. Raw-socket requests must carry `Host: 127.0.0.1:<port>` (with port); a bare
   `Host: 127.0.0.1` gets 403 `host_denied`. Fuzz-harness note only.

## Files

- `worker-50/fuzz.mjs` — main harness (30 fetch + raw cases), writes
  `worker-50/fuzz-results.json`.
- `worker-50/probe.mjs`, `worker-50/probe2.mjs` — follow-up probes
  (Host-header 403 root cause, TRACE/CONNECT/PUT/OPTIONS with correct Host).
- `worker-50/fuzz-results.json` — full case list with statuses/verdicts.
- `worker-50/REPORT.md` — this file.
