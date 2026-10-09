# WORKER 29 — shard fuzz report (WAVE-2000 GUILD-02)

Shard: route-handler lines in server/http.mjs matching `if (url.pathname === "…"` /
`if (inboundPath === "…"`, sorted by line number, index mod 50 == 28 (0-based; the
task's `app.get(`/`app.post(` pattern does not exist in this codebase — it uses
manual pathname dispatch). 88 handler lines total → shard = 2 handlers.

- **idx 28 → http.mjs:2054** `if (url.pathname === "/api/account-rooms" && req.method === "POST")`
- **idx 78 → http.mjs:3032** `if (url.pathname === "/api/referral-invites/preview" && req.method !== "POST")`
  (405 guard; fuzzed together with its POST handler at http.mjs:3031)

Method: local server booted on the acceptance fixture (`scripts/acceptance-fixture.mjs`),
fresh TCP connection per probe (keep-alive reuse after the oversize-body case desyncs
client framing — statuses were right but bodies misparsed; re-verified in isolation).
Server stayed alive through all runs; zero crashes, zero hangs, zero 5xx.

## Coverage (worker-29/fuzz29.mjs, ~45 probes)

POST /api/account-rooms (auth-required; no valid session obtainable without a full
sign-in, so unauth/malformed-auth ordering fuzzed):
- no cookie+binding → 422 session_binding_required; malformed binding → 422 invalid_session_binding
- binding w/o cookie, garbage cookie → 401; duplicate session cookie → 401 ambiguous_session_cookie
- query `?binding=` params are IGNORED by this route (handler calls `accountBinding(req)`
  without `url`, http.mjs:2057) — header/query mismatch does not 422, it 401s on auth
- invalid JSON / wrong content-type bodies never 5xx (401, auth runs first)
- trailing slash `/api/account-rooms/` and `/room/` prefix normalized to the same handler

POST /api/referral-invites/preview (unauthenticated):
- `{}` → 422 invalid_invite; token as number/array/object/null/bool → 422; extra field → 422
  (exact() gate uses Object.hasOwn — prototype-pollution safe; own `__proto__` key → 422)
- garbage string token → 404 invite_unavailable (no timing blowup: 10k-char token → 48ms)
- unicode/surrogate token → 404, no 5xx; invalid JSON → 400 invalid_json; array/null body → 400
- text/plain → 415 json_required; 20KB body (16KB limit) → 413 too_large
- non-POST (GET/PUT/PATCH/DELETE/HEAD) → 405 method_not_allowed; OPTIONS → 405 (preflight
  denied — no global CORS preflight path; consistent with the route's strict posture)
- rate limit `referral-invite-preview:<addr>` engages at request #21 of 25 (limit 20/min) ✓

## Finding (fail-first test included)

**F-1 (low, wrong-status):** PUT/PATCH/DELETE/HEAD/OPTIONS on the existing
`/api/account-rooms` resource return **404 not_found** instead of 405.
Sibling routes carry explicit 405 guards with Allow headers
(`/api/referral-invites/preview` http.mjs:3032 → `Allow: POST`;
`/api/public/rooms/directory` http.mjs:1729; `/api/opportunities.json` http.mjs:1829).
Repro: `curl -X PUT http://127.0.0.1:PORT/api/account-rooms` → 404 `not_found`.
Fail-first test: `worker-29/account-rooms-405.test.mjs`
(`node --test worker-29/account-rooms-405.test.mjs`) — fails now (404 vs 405),
passes once a 405 guard is added.

## Gaps (not reachable from this worker)
- Authenticated POST /api/account-rooms body handling (CSRF `protectWrite`, `store.createAccountRoom`
  request-shape validation) — needs a real signed-in account session; unauth ordering verified only.
- A valid signed referral-invite token's preview happy path (needs `mint`, auth-required).

## Files
- `worker-29/shard.txt` — shard handler lines
- `worker-29/fuzz29.mjs` — probe harness
- `worker-29/account-rooms-405.test.mjs` — fail-first test for F-1
- `worker-29/REPORT.md` — this report
