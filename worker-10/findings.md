# WORKER 10 findings — WAVE-2000 guild-02 (shard idx 9, 59)

Scope: legacy-chain route handlers in server/http.mjs
- idx 9 : `GET /api/auth/github/start` (http.mjs:1260; GITHUB_START_PATH = "/api/auth/github/start")
- idx 59: `GET|HEAD /api/guest-agent-links` (http.mjs:2416)

Method: local-only fuzz (never production). Throwaway sqlite store in
`$worktree/.tmp`, `createRoomServer`, random 127.0.0.1 port. 113 probes total:
90 via `fuzz.mjs` (methods × path shapes × query shapes × header shapes × raw
socket shapes), 20 via `fuzz-raw.mjs` (request-line/header smuggling with a
correct Host so shapes actually reach the handlers), 3 header checks.
8s per-request timeout (hang detection); server liveness re-verified at end
(`/api/health` → 200).

## Verdict: CLEAN — no crashes, no hangs, no wrong-status

Timeouts: 0. Transport errors: 0. Server healthy after all probes.

### Route A — GET /api/auth/github/start (OAuth unconfigured locally)
- GET → 503 `github_not_configured` JSON ✓; `Accept: text/html` → 503 HTML page ✓
- HEAD/POST/PUT/DELETE/PATCH/OPTIONS/TRACE → 405 ✓; unknown verb (FOOBAR) → 400 (node parser) ✓
- Trailing/double slashes → 503 (up-front normalization) ✓
- Case variants, `%2f`/`%00`/`%c0%af`/`%252f` in path, `//api`, `/api//`, `%61pi` → 404 ✓
- `/api/./x`, `/api/../api/x` → normalized to the route → 503 ✓ (URL normalization, intended)
- `?sessionToken=*` (empty/huge/dup/array/bad-encoding) → 503 (oauth check precedes sessionToken) ✓
- 40k query / 30k param name / 20k cookie → 431 ✓ (node header cap)
- Origin mismatch → 403 `origin_denied` ✓; matching Origin → 503 ✓
- Absolute-form target (`GET http://127.0.0.1:PORT/...`) → 503 ✓
- Raw: garbage verb/tab-in-target/null-prefix/long-method → 400 ✓; dup Content-Length / CL+TE clash → 400 ✓ (node)
- Duplicate Host: first value wins (correct-first → 503, evil-first → 403) ✓

### Route B — GET|HEAD /api/guest-agent-links
- GET → 200 static contract JSON (`{"status":"live","kind":"agent",...}`) ✓; HEAD → 200 empty body ✓
- Trailing/double slash → 200 ✓; case/`%2f`/`%00`/double-slash variants → 404 ✓
- PUT/DELETE/PATCH/OPTIONS/TRACE → 404 (legacy fallthrough; no 405 row for these methods) ✓ per code intent
- POST → 403 "Origin header is required" (row idx 60, worker-11's row — expected for that row) ✓
- Origin mismatch / trailing-space Origin → 403 ✓ (no trim bypass); matching Origin → 200 ✓
- 20k cookie → 431 ✓; chunked GET → 200 ✓; absolute-form → 200 ✓; HTTP/1.0 → 200 ✓
- `Accept: text/html` → 200 JSON (no content negotiation; static contract) ✓

## Observations (not findings — no repro/test owed)
1. `405` on `/api/auth/github/start` carries **no `Allow` header** (http.mjs:1261:
   `reject(405, "method_not_allowed", "Method not allowed")` — no `{ Allow }`
   extra). The route-table dispatcher contract ("including 405 Allow on a known
   path") promises Allow, but this legacy row omits it. Cosmetic; status code
   itself is correct.
2. Absolute-form request targets: the authority is ignored in favor of the Host
   header (`GET http://evil.example/api/auth/github/start` with correct Host →
   503 as if local). Host check compares only `req.headers.host`. No auth or
   routing bypass results on these two routes (both are pre-auth), but the
   authority/Host divergence is worth knowing for routes where origin matters.
3. PUT/DELETE/etc on `/api/guest-agent-links` answer 404 from the generic
   fallthrough rather than 405-with-Allow — matches the legacy chain's
   documented "fall through" behavior, but differs from the route-table
   convention. Cosmetic.

## Files
- `worker-10/shard.txt` — shard definition (idx 9, 59; why these rows)
- `worker-10/fuzz.mjs` — 90-probe harness
- `worker-10/fuzz-results.txt` — full 90-probe output
- `worker-10/fuzz-raw.mjs` — 20-probe raw-socket harness
- `worker-10/fuzz-raw-results.txt` — raw probe output
- `worker-10/findings.md` — this file
