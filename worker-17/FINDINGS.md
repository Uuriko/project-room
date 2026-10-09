# WORKER 17 — findings

Shard: unique literal route paths in `server/http.mjs`, `(index mod 50)==16`
(the task's literal `app.(get|post|…)` grep matches nothing in this codebase —
routes dispatch via `url.pathname ===` in a legacy if/else chain plus
`dispatchRoute`; the guild charter's "~88 literal routes" = the 88 unique
`url.pathname === "<path>"` literals, which is the list partitioned here).

- index 16 → `GET|HEAD /api/ready` (http.mjs:1631)
- index 66 → `POST /api/invitations/preview` (http.mjs:2583)

Method: local-only raw-socket fuzzing (`fuzz-w17.mjs`) against a fresh
`RoomStore` + `createRoomServer` on 127.0.0.1. 71 cases, 0 failures
(70 PASS, 1 informational KNOWN-HANG — see below).

## Verdict: no new bugs

No 500s, no hangs, no dropped connections, no wrong statuses on either
route. Error taxonomy observed (all correct):

`/api/ready`
- GET/HEAD → 200 `{status:"ready"}`; HEAD sends no body. Trailing-slash
  `/api/ready/` → 200 (normalized at http.mjs:952). `/api/./ready` → 200
  (WHATWG URL dot-segment normalization). Query strings ignored → 200.
- POST/PUT/DELETE/PATCH/OPTIONS/TRACE → 404 (falls through the legacy
  chain; this route is NOT in `LIVENESS_GET_ONLY_PATHS`, so no 405+Allow —
  consistent with the code's deliberate scoping of #1529, noted not filed).
- Unknown/lowercase methods → 400 (Node parser). NUL in path → 400.
  10KB path → 404. Query bomb / huge User-Agent → 431. No Host → 400.
  HTTP/1.0 → 200. Absolute-URI target → 200. Pipelined 2× GET → 200,200.

`POST /api/invitations/preview`
- Missing/wrong/empty/`null`/trailing-slash Origin → 403 `origin_denied`
  (strict `checkOrigin(req, true)`). Note: `GET /api/ready` with a foreign
  Origin also 403s via the GLOBAL preamble guard at http.mjs:1020 — intended.
- Well-formed but unknown token (43-char, also 10k-char/unicode/space
  variants, bad-char, short) → 404 `invitation_unavailable` — never 500, even
  for 10KB tokens (`hash(token)` handles arbitrary length).
- Body errors: empty/malformed/array/string/number/null body → 400
  `invalid_json`; missing/extra/`__proto__` keys or non-string token
  (number/null/array/object/bool/deeply-nested) → 422; wrong/missing
  content-type → 415 (charset param accepted); 20KB body → 413 naming actual
  size; declared-CL-larger-than-actual → 400; chunked encoding → works (404
  for unknown token); NUL byte in JSON → 400; duplicate Content-Length → 400.
- Wrong methods (GET/HEAD/PUT/DELETE/PATCH/OPTIONS) → 404.
- Rate limit: 30 req/min per IP (`invitation-preview:${remoteAddress}`) —
  probe showed exactly 30×404 then 429s with the JSON envelope. 20-concurrent
  burst → all answered, no 500s.

## Not filed (known / out of shard scope)

- Slow-drip stalled body hangs: the connection is never terminated despite
  `server.requestTimeout = 15000`. Reproduced on plain Node v24 too
  (`probe-stall2.mjs`) — Node-level behavior, server-wide, and the
  coordinator's own F07 "slowloris-drip" already FAIL-HANGed on it. Not a
  new shard finding; no fail-first test written (fix belongs at transport
  level, out of this shard's scope).
- No fail-first regression tests added: nothing failed, so per the mission
  (repro + test only on crash/hang/wrong-status) none are owed.

## Files

- `worker-17/shard.txt` — shard definition (index:line:handler)
- `worker-17/fuzz-w17.mjs` — harness (re-runnable: `node worker-17/fuzz-w17.mjs`)
- `worker-17/results.json` — full per-case results
- `worker-17/probe-stall2.mjs` — requestTimeout stall investigation
