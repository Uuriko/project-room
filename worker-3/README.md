# WORKER 3 — shard report (WAVE-2000 guild-02, server/http.mjs API fuzz)

## Shard
Inline-conditional router (no `app.get` style): 103 pathname-conditional entries,
sorted by line; shard = entries where (index mod 50) == 2:
- idx 2 · line 1073 — `GET/HEAD /api/health` (+aliases `/api/health/`, `/api/healthz`,
  `/healthz`, `/room/health[/]`, `/room/api/health[/]`, `/room/healthz[/]`, `/room/api/healthz[/]`); other methods → 405
- idx 52 · line 2356 — `/api/account/profile` (GET: account session; POST: checkOrigin+rate+CSRF protectWrite, 16 KiB body cap)
- idx 102 · line 3181 — `GET/HEAD /api/updates` (bearer identity secret or account session + `x-session-binding`; query params state/kinds/cursor/limit)

## Method
Local server only (127.0.0.1:4773, isolated sqlite in worker-3/fuzz-data/). ~160 cases:
fuzz.mjs (unauth: path shapes, methods, oversized/duplicate headers, raw-socket
request-line/Header smuggling shapes, oversized bodies/query) and fuzz-auth.mjs
(real local signup → password login → csrf/binding headers; authenticated profile
POST body shapes + updates query shapes).

## Result: NO crash / hang / wrong-status findings
- No 500s, no uncaught exceptions in server log, server stayed alive throughout.
- Statuses all in-family: 200/404 (health paths; dot-segments normalized per WHATWG URL),
  405+Allow (wrong method on health/updates/profile), 401 (profile/updates no auth),
  403 (origin/CSRF/session gates), 400 (invalid JSON, bad request line), 413 (bodies
  > 16 KiB, headers/query > Node limits), 422 (invalid_profile / invalid_updates_query /
  invalid_cursor / session_binding_required), 431 (oversized headers/query via Node).
- `blank-line` raw socket: server holds connection (Node default request timeout);
  standard behavior, no hang of the process. ECONNRESETs on 100 KiB-body and CONNECT
  cases are client-side (server closed after 413/unsupported verb; log clean,
  subsequent requests fine).

## Observations (not findings)
- `GET /api/updates?limit=0x10` and `?limit=+5` return 200 (server/updates.mjs:356
  parses with `Number()`: 0x10→16, +5→5; both safe integers 1–100). Lenient but
  semantically consistent with the error message — no test written.
- `HEAD /api/account/profile` → 405 (only GET/POST); `OPTIONS /api/health` → 404
  (deliberate: the 405 liveness block skips OPTIONS per #1529). As coded.

## Files
- worker-3/fuzz.mjs, worker-3/fuzz-results.txt (105 unauth/raw cases)
- worker-3/fuzz-auth.mjs, worker-3/fuzz-auth-results.txt (52 authenticated cases)
- worker-3/fuzz-data/ (isolated sqlite + server log, local only — never production)
