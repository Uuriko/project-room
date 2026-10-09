# WORKER 35 report — shard 35/50: GET /api/account/onboarding (server/http.mjs:2368)

## Shard
Route list = `url.pathname === "/api/..."` matches in server/http.mjs sorted by line
(83 total; the task's `app.(get|post|...)` regex matches nothing — this codebase uses a
hand-rolled pathname/method dispatch, so the natural route list was used).
Shard 35 → 1-based index 35 → **line 2368: `GET /api/account/onboarding`**.

Handler:
```js
if (url.pathname === "/api/account/onboarding") {
  if (req.method !== "GET") reject(405, "method_not_allowed", "Method not allowed");
  const session = requireAccountSession();
  return json(res, 200, store.onboardingState(session.account.id));
}
```

## Method
- Local server on 127.0.0.1:4355, private sqlite DB (worker-35/.tmp/w35-room.sqlite).
- Seeded a real authenticated account session via store methods
  (`createAccount` + `loginAccountSessionWithMethod`, rotateSlot) — no mailer available locally.
- 45 fuzz checks (worker-35/fuzz.mjs, results in worker-35/fuzz-results.json):
  auth states (none/anon-slot/garbage/other-cookie), method matrix
  (POST/PUT/PATCH/DELETE/OPTIONS/HEAD/TRACE/PROPFIND), path encodings
  (trailing slash, double slash, %2F, %6F, %00, semicolon param, case, huge query/path),
  header fuzz (12KB cookie, malformed cookie, 15KB header, Host mismatch),
  GET-with-body, 60-way concurrency, raw-socket garbage method / oversized line / huge cookie.

## Findings
**None.** All 7 initial flags were investigated and ruled out:
1. `GET /api/account/onboarding/` → 200, not 404 — global trailing-slash normalization
   (http.mjs ~951-953, deliberate per QA 2026-10-03 P2-1); identical on sibling routes.
2. `/api/account/%6Fnboarding` → 404 — server never percent-decodes pathname; consistent globally.
3. GET + JSON body (client-sent chunked) → 400 — client framing artifact: node http client
   emitted headers + raw body without Transfer-Encoding, i.e. a smuggling shape;
   bare node `http.createServer` rejects it identically (`HPE_INVALID_METHOD`). Correct behavior.
4. 1/60 requests ECONNRESET — one-off keep-alive reuse race; 120/120 clean on two re-runs.
5-7. duplicates of 1-3 (FLAG wrapper entries).

Baseline behavior verified correct:
- no/invalid session → 401; anonymous slot → 401; authed → 200 with
  `{accountId, completed:false, steps:[set-profile, review-signin]}`.
- every non-GET method → 405 (codebase convention).
- garbage method line → `HTTP/1.1 400 Bad Request`; 20KB request line / 50KB cookie → 431.
- Host mismatch → 403. Malformed cookie → 401.

## Files
- worker-35/fuzz.mjs — fuzz harness
- worker-35/fuzz-results.json — all 45 check results
- worker-35/seed.mjs — DB seed (authenticated session)
- worker-35/chunked*.mjs, rawdump.mjs — repro/analysis scratch for the chunked-body flag
- worker-35/REPORT.md — this file

No fail-first test written: no reproducible bug; the route already has coverage in
tests/account-management.test.js. No crash, hang, or wrong-status found.
