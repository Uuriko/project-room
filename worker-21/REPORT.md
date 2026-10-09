# WORKER 21 report — API fuzzing, shard 21/50

## Shard definition (adapted)
The task's `app.(get|post|…)` grep matches nothing in this codebase: `server/http.mjs`
is a raw `node:http` server with a `url.pathname === …` dispatch chain, not Express.
Shard = sorted dispatch-condition lines, 0-based index `i` where `i % 50 == 20`
(i.e. 1-based items #21 and #71 of 98):

1. **GET /api/agent-invites/preview** — `server/http.mjs:3038` (unauthenticated; `code` query param → `store.invites.preview(code)`)
2. **POST /api/referral-invites/preview** — `server/http.mjs:3026` (unauthenticated; JSON `{token}` exact-shape → `store.referralInvites.preview(token)`)

## Method
In-process harness (`fuzz-local.mjs`): boots the real `createRoomServer` (same as
`server.mjs`) on a scratch SQLite DB in `worker-21/.tmp/`, runs a 28-case battery
(missing/empty body, wrong types, extra keys, non-object JSON, malformed JSON,
wrong/missing content-type, 200KB token, unicode token, `__proto__` key, wrong
methods, missing/empty/huge/unicode/SQL-ish/duplicate code params), then shuts down.
External `node server.mjs` processes kept getting reaped on this box, so in-process
was used for determinism. Rate limit (20/min/key) respected — battery stays under it.

## Results
27/28 clean (all expected 4xx shapes: 400/404/405/413/415/422). No 5xx, no hang,
server healthy after every case (`/api/health` 200 throughout).

### FINDING 1 (actionable, fail-first test written)
**Wrong status: wrong-method on GET /api/agent-invites/preview returns 404, not 405.**
`POST`, `PUT`, `DELETE` to `/api/agent-invites/preview` fall through to the generic
404. The sibling route (`POST /api/referral-invites/preview`, http.mjs:3032) and
~66 other dispatch sites answer 405 with an `Allow` header for known-path/wrong-method.
A known resource with a disallowed method should be 405 (RFC 9110 §15.5.6).
- Minimal repro: `curl -X POST http://127.0.0.1:PORT/api/agent-invites/preview?code=x -H 'Content-Type: application/json' -d '{}'` → 404 (want 405, `Allow: GET`).
- Fail-first test: `worker-21/agent-invites-preview-method.test.mjs` — 2 fail (bug), 1 control passes.

### Investigated and cleared (no bug)
- **Socket hang-up after a 413**: first fuzz run showed `conn:socket hang up` on the
  request following an oversize-body 413. Repro (`repro-unicode.mjs`, `probe-413-url.mjs`)
  proved it is a client keep-alive race against the server's *intentional*
  drain-then-half-close on 413 (`server/http.mjs` ~4990, `#976` comment). On a fresh
  connection: 413 → next request 404 → health 200, all correct. Not a server bug.
- **200KB query string → ECONNRESET**: `GET /api/agent-invites/preview?code=<200KB>` gets
  the connection destroyed with no response (Node parser-level request-line rejection;
  no app `clientError` handler; applies to all routes equally). Server stays healthy
  (health 200 after). Codes up to 16K chars → 404 normally. Not a crash/hang; noted as
  low-severity observation, no test (pre-dispatch platform behavior, not route logic).

## Files (all under ~/workspace/pr-wave2000-guild-02/worker-21/)
- `fuzz-local.mjs` — in-process fuzz harness + 28-case battery
- `fuzz.mjs` — external-server variant (unused; server kept getting reaped)
- `repro-unicode.mjs` — minimal repro isolating the post-413 keep-alive race
- `probe-413-url.mjs` — 413-fresh-connection + URL-length sweep probes
- `agent-invites-preview-method.test.mjs` — FAIL-FIRST test for Finding 1
- `.tmp/` — scratch DBs, server logs, fuzz output (evidence)
- `REPORT.md` — this file

## Open / not done
- No code fix applied (worker role: fuzz + fail-first test only; no commit per task).
- Rate-limit 429 surface not exercised (would need >20 req/min; expected behavior per `rate()`).
- Auth-gated behavior of these routes not tested (both are intentionally unauthenticated).
