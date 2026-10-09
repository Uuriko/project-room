# WORKER 37 — API fuzz results (shard 37/50, guild-02 slice: server/http.mjs)

Shard = sorted route-handler lines from `grep -nE "(url\.)?pathname ===" server/http.mjs`
(107 lines; identical byte-for-byte to worker-9/all-pathname-routes.txt), indices i with i%50==36:
- **index 36 → server/http.mjs:1929** — `GET/HEAD /favicon.ico`, `/room/favicon.ico` → 301 to `/favicon.svg` / `/room/favicon.svg`
- **index 86 → server/http.mjs:2880** — `POST /api/claims/validate` (unauthenticated claim-block pre-validator, 30/min/address)

Method: local server boot (`PORT=4711`, disposable sqlite in `.tmp/`, own instance lock in
`worker-37/.instance.lock`), 54-case raw-http fuzz in `worker-37/fuzz.mjs`, full log in
`worker-37/results.json`. Server still running on 127.0.0.1:4711 at write time.

## Verdict: no crash / hang / wrong-status found. No fail-first test warranted.

All 500-class, hang (>3s), and unexpected-status cases: **zero**. Worst latency 212ms (first
request, cold). No uncaught exceptions in server.log across the run.

## Confirmed-correct behavior (spot checks passed)
- favicon: `GET /favicon.ico` → 301 `/favicon.svg`; `GET /room/favicon.ico` → 301 `/room/favicon.svg`;
  HEAD → 301 empty body; both redirect targets return 200 `image/svg+xml` (no dangling redirect).
- claims/validate: non-POST → 405 with `Allow: POST`; missing/wrong content-type → 415;
  empty/malformed/non-object JSON → 400 `invalid_json`; missing/extra fields or non-string text →
  422 `invalid_claim_text`; text > 65536 chars → 422 `text_too_long`; body > 73728 bytes →
  413 `too_large`; valid claim → 200 `{"valid":true,...}`; invalid claim → 200 `{"valid":false,"errors":[...]}`;
  rate burst → 429 `rate_limited` with `Retry-After: 60` (limiter trips on the 31st POST in the window).
- claim semantics spot-checked: bare `state: failed` → "failed requires a failure code"
  (matches the intentional deviation documented in server/claim-validate.mjs); `failed(OOM)` → valid;
  `lease=0h` → "lease out of range 1-72h"; charset/case variants of `application/json` accepted.

## Observations (investigated, not bugs)
1. **Trailing slash normalizes by design** — `GET /favicon.ico/` → 301 `/favicon.svg`.
   server/http.mjs:948-950 strips trailing slashes up front (QA 2026-10-03 P2-1). Expected.
2. **Scheme-relative request target quirk** — `GET //favicon.ico` → 200 homepage.
   `new URL("//favicon.ico", origin).pathname` is `/` (first segment parsed as host, discarded;
   only pathname is dispatched). `//api/health` → pathname `/health` → 404. Harmless: the
   surviving path is dispatched exactly as if requested directly; auth is header-based, so no
   bypass. The truly-unparseable `//` case is already 400 per the QA 2026-10-04 guard at :942-945.
3. **100 KB query string → ECONNRESET (transport-level)** — also happens on `/api/health`;
   Node's 16 KB request-line cap destroys the socket before the app sees it. Not handler-specific.
   A 10 KB query on `/favicon.ico` → 301 with query correctly dropped from `Location`.
4. **B23 expectation was my test's error, not the server's** — a ~73.5 KB body (under the 73728-byte
   body cap) with text > 65536 chars correctly returns 422 `text_too_long`; the body cap
   intentionally exceeds the text cap to allow JSON-envelope overhead (server/http.mjs:2883).
5. **B25 transient `socket hang up` (1 ms) did not reproduce** — 5/5 isolated retries returned the
   expected 422 `invalid_claim_text`. Server log shows no exception; classified as a one-off
   client/transport race, not a server defect.
6. **Infra note (not a product finding)** — the first server instance was SIGTERM'd by the runtime
   ~20 min in (no crash, clean log); restarted with a fresh lock and all follow-ups re-verified.
   First boot attempt failed with `instance_lock_held` because a sibling worker holds
   `.tmp/.project-room.lock` — used `ROOM_INSTANCE_LOCK_PATH=worker-37/.instance.lock` to coexist.

## Repro commands (for any follow-up)
```
cd ~/workspace/pr-wave2000-guild-02
PORT=4711 ROOM_DB=$PWD/.tmp/fuzz-worker37.sqlite ROOM_INSTANCE_LOCK_PATH=$PWD/worker-37/.instance.lock TMPDIR=$PWD/.tmp node server.mjs
node worker-37/fuzz.mjs   # 54 cases -> worker-37/results.json
```
