# server/http.mjs — module documentation (wave1000 guild-02)

4777 lines. The entire HTTP surface of Project Room: one `createRoomServer()`
factory returning a `node:http` server. Two module-level exports:
`createRoomServer({...})` and `touchLruEntry(...)` (LRU helper, exported for
unit tests).

## Request lifecycle (the funnel)

Every request passes these stages in order; each stage either finishes the
response or falls through:

1. **Security headers** — set on EVERY response before routing:
   `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, HSTS
   `max-age=31536000` (no includeSubDomains), a locked-down CSP,
   `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`.
2. **Host check** — `req.headers.host` must equal the expected origin's host,
   else 403 `host_denied`.
3. **Client address** — `resolveClientAddress` (proxy-aware); misconfiguration
   → 403 `proxy_denied`.
4. **URL parse** — `new URL(req.url, origin)`; unparseable targets (e.g.
   `//`) → 400 `invalid_request` (deliberate: used to fall through to 500).
5. **Trailing-slash normalization** — once, up front: `url.pathname` only
   (`req.url` untouched for diagnostics). Only length-2 `"//"` is affected
   by the `> 1` boundary, and it already 400s at step 4.
6. **security.txt** — `/.well-known/security.txt`, `/security.txt`,
   `/room/.well-known/security.txt`; GET/HEAD only (else 405); 404 unless
   `ROOM_SECURITY_CONTACT` is set and CRLF-free.
7. **MCP path** (`/mcp`, `/room/mcp`, `/mcp/<client>`…) — per-IP rate limit;
   POST reads the body with an attachment-aware limit, then
   `writeRoomMcpNode`.
8. **A2A path** — per-IP rate limit; POST reads JSON body.
9. **Origin gate** — `checkOrigin(req)` for everything except the share-link
   preview (edge-door origins only) and public-receipts reads (which get
   `Access-Control-Allow-Origin: *` instead).
10. **`dispatchRoute`** (server/routes/dispatch.mjs) — the new route table
    ("batch RT"). A matched row finishes here, including 405+Allow on known
    paths. Receives a large context object (json, reject, rate, cookie,
    bearer, body, readText, roomAuth, exact, pathId, limiters, transports…).
11. **Legacy chain** — liveness (`/api/health`, `/api/version`: GET/HEAD
    only, else 405+Allow), OAuth callbacks (Google/GitHub/Gmail), then the
    room/account/inbox route sequence.
12. **Static/public pages** → 404: JSON envelope by default; `404.html` when
    the client Accept prefers `text/html` (and the path is a public page).
    Non-`/api/` unknown paths → 404 `not_found`.
13. **Catch** — see error taxonomy.

## Error taxonomy

- `reject(status, code, message, headers)` throws `ServiceError`; the tail
  catch maps it to JSON.
- Envelope: `{ error: { code, message }, operationId, category }`, merged
  with `agentErrorBody(...)` on room routes (adds `status`, `reason`,
  `hint`, `next` guidance) and optional discoverability overrides.
- 500s never leak internals: message becomes "Service could not complete
  the request; no success is claimed", code `internal_error`.
- 413 has special drain logic: after `finish`, in-flight request bytes are
  drained without buffering (1 s re-arming deadline) so slow-but-alive
  uploads still read the `too_large` message; only stalled senders are
  destroyed.
- Diagnostics: every room-scoped error is recorded with a templated route
  (`/api/rooms/:roomId/...`, ids → `:item`); non-room 5xx leave an operator
  trace. Query strings, headers, bodies never enter diagnostics.
- Common codes: 400 `invalid_request`/`invalid_json`/`aborted`,
  401 `unauthenticated`/`invalid_session`/`ambiguous_session_cookie`,
  403 `host_denied`/`proxy_denied`/`csrf_denied`/`access_denied`,
  404 `not_found`, 405 `method_not_allowed` (+`Allow`),
  413 `too_large` (names limit AND actual bytes — G7),
  415 `json_required`/`ndjson_required`,
  422 `invalid_*` (strict-shape violations),
  429 `rate_limited`/`stream_limit` (+`Retry-After`).

## Invariants

- **Auth usually runs before `body()`** — unauthenticated garbage gets 401,
  not 400/415. (Consequence: body-validation tests must authenticate.)
- **Strict body shapes** — `exact(data, [...])` requires exact key count AND
  names; every call site additionally type-checks the named fields, so the
  name check is defense-in-depth (see mutants.md M02).
- **Body limits** — `readText`: declared `Content-Length` over the limit is
  refused immediately (draining in background); unknown-length bodies drop
  over-limit chunks while counting, so the 413 names the true size; aborts
  → 400. Default JSON cap 16 KiB; the commands route uses 512 KiB
  (`MAX_MESSAGE_COMMAND_BYTES`).
- **Rate limiting** — `rate(id, max)` per key, 60 s windows, per-family cap
  of 2000 keys (oldest family key evicted, never global lockout); abuse
  families persist strides to the DB.
- **Streams (SSE)** — global cap 100, per-credential cap 3 → 429
  `stream_limit`; lagging consumers get one `stream_lagging` event then a
  5 s drain grace; `Last-Event-ID` resume; per-connection send-queue cap
  (`streamQueueCap`).
- **Cookies** — `__Host-` prefix on HTTPS; duplicate session cookies →
  401 `ambiguous_session_cookie`; cookie-based writes are CSRF-checked
  (`protectWrite`).
- **Timeouts** — `requestTimeout 15000`, `headersTimeout 10000`,
  `keepAliveTimeout 5000` are SET but do not bound slowloris holds in this
  runtime (verified: idle/dripping connections survive 25–30 s on both this
  server and bare `node:http`; see fuzz.md).

## Callers

- `server.mjs` — production Node boot (args from `deploymentConfig()`).
- `cloudflare/room.mjs` — Worker entry.
- `perf/local-server.mjs`, `machine/` harnesses.
- 100+ test files import `createRoomServer` directly.

## Gotchas

- New routes belong in `server/routes/dispatch.mjs` (batch RT), not the
  legacy chain — the legacy chain is being drained.
- `dispatchRoute`'s context object is the seam: anything a route needs
  (limiters, transports, mailers) must be threaded through it.
- `url.pathname` is rewritten (`rewriteRoomApiPrefix`) for `/room/api/*`
  aliases; `req.url` is the diagnostic source of truth.
- `signInSlotToken` accepts the slot from the HttpOnly cookie when the body
  omits `sessionToken` — CSRF-protected via `protectWrite`.
- The Jev admission gate is shadow-mode: it never throws, never blocks.
- `server.closeStreams()` / `closeAllConnections()` exist for tests; the
  413 drain re-arms its destroy deadline while bytes flow.
- `ROOM_SECURITY_CONTACT` with a colon is treated as a URI (must be
  `mailto:`/`https:`); CRLF anywhere is rejected.
