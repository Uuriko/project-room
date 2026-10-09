# WORKER 25 — shard report (guild-02, server/http.mjs)

Shard: route-condition list = `grep -n 'pathname ===' server/http.mjs` (102 entries,
0-based, same construction as worker-9's shard.txt). Indices with (index mod 50)==24:
- **idx 24 → line 1713**: `GET|HEAD /openapi.json` (+ `/room/openapi.json` alias)
- **idx 74 → line 2536**: `POST /api/share-links/join-agent`

Method: local server on 127.0.0.1:49125 (worktree branch wave2000/guild-02),
~45 fuzz requests + targeted follow-ups. No crashes, no hangs, no 500s.

## Findings

### F1 (fix + fail-first test): 405 on /openapi.json lacks the `Allow` header
- Location: server/http.mjs:1715 (now 1715 after edit — the reject inside the
  `/openapi.json` handler).
- Repro: `curl -X POST http://127.0.0.1:49125/openapi.json -i` → 405 with no
  `Allow` header. Same for PUT/DELETE/OPTIONS/PATCH.
- Why it matters: RFC 9110 §15.5.6 requires `Allow` on 405. The sibling
  POST-only route `/api/share-links/join-agent` sends `Allow: POST` on its 405
  (http.mjs:2561), and the liveness-path convention is "405 with Allow (#1529)".
- Fix applied in worktree (uncommitted, one line):
  `reject(405, "method_not_allowed", "Method not allowed", { Allow: "GET, HEAD" })`
- Fail-first test: `worker-25/openapi-allow-header.test.js` — fails on pre-fix
  code ("POST: 405 response must carry an Allow header"), passes post-fix
  (verified both directions). Existing `tests/discoverability.test.js`: 15/15 pass.

### Fuzz matrix summary (all expected statuses, no anomalies)
`/openapi.json`: GET→200 (valid OpenAPI 3.1.0 doc, ~95KB, 174ms worst case),
HEAD→200 empty, /room alias→200, POST/PUT/DELETE/OPTIONS→405,
query strings ignored→200, `/openapi.JSON`→404 (case-sensitive),
trailing slash→200 (intended: generic normalization, http.mjs:951),
evil Host header→200 (no origin gate on this route — public by design).
`POST /api/share-links/join-agent`: no-auth+no-origin→403, wrong origin→403,
no auth→401, malformed bearer→401, `rak_` room token→401 room_token_not_identity,
lowercase `bearer` scheme→accepted (case-insensitive per RFC 7235),
wrong content-type→415, invalid JSON/array body→400, missing/extra keys→422,
non-string/blank/81-char displayName→422, garbage/empty/numeric/null
linkToken→410 link_unavailable, GET→405 with `Allow: POST`,
20KB body→413 too_large (limit 16384), rate limit 20/min→429 from request 21.

### Cross-shard observation (not mine, no test written)
`GET //openapi.json` → 200 serving index.html: `new URL("//openapi.json", origin)`
parses as host `openapi.json`, pathname `/`, hitting the asset fallback. This is
the generic request-target handling (http.mjs:942-951), likely another worker's
slice — flagging for the integrator only.

## Files
- worker-25/shard.txt — shard route list
- worker-25/fuzz.mjs, worker-25/fuzz2.mjs — fuzz scripts
- worker-25/results.json, worker-25/fuzz.out, worker-25/fuzz2.out — raw results
- worker-25/openapi-allow-header.test.js — fail-first test (F1)
- worker-25/server.log — local server log (server still running, port 49125)

## Worktree changes (uncommitted, for guild integrator)
- server/http.mjs: one-line fix (F1) — `git diff` shows exactly 1 insertion/1 deletion.
