# WAVE-2000 guild-02 — worker 6 (shard 6/50) report

- **Shard definition**: sorted unique exact-path route registrations in `server/http.mjs`
  (`grep -noE 'url\.pathname === "([^"]+)"' | unique | sort`), 88 total, `(0-based index mod 50) == 5`
  → indexes 5, 55 → **`/api/account-rooms`** and **`/api/public-work/match`**.
  (Note: this codebase dispatches routes via `if (url.pathname === ...)` chains, not
  `app.get(...)`; the partition was applied to the equivalent route-registration lines.)
- **Harness**: `worker-6/fuzz.mjs` (126 cases), `worker-6/verify2.mjs` (happy-path + rate verification).
  Local server via acceptance fixture; no `node_modules` needed (`node:sqlite` built-in).
  Authenticated cases used store-minted account sessions (slot → access key → login) with
  cookie + `X-Session-Binding` + `X-CSRF-Token` + `Origin`.
- **Result**: 126 fuzz cases + follow-ups → **0 crashes (5xx), 0 hangs**. Status spread:
  200×12, 201×11, 400×9, 401×8, 403×4, 404×5, 405×7, 413×1, 415×7, 422×36, 429×26.
  Body-limit (16 KiB → 413), content-type (415), malformed JSON (400), proto-pollution keys (422),
  duplicate query/body fields (422), bad CSRF/origin/binding/cookie (403/422/401) all behaved.
  Happy path verified: POST create → 201, idempotent re-create → 200 `duplicate:true`,
  conflicting roomId → 409 `room_exists`, GET list → 200.
  Rate limits verified exact: `account-room-create` allows precisely 10/min per account
  (10×201 then 429), `public-work-match` 60/min not tripped.

## Findings

### W6-01 — wrong status: unsupported methods on /api/account-rooms return 404 instead of 405 (minor)
- **File:line**: `server/http.mjs:2049` (`GET /api/account-rooms`) / `:2054` (`POST /api/account-rooms`).
  The route chain has no method guard, so PUT/PATCH/DELETE/OPTIONS/HEAD fall through to the
  generic 404.
- **Expected**: 405 `method_not_allowed` — the codebase's own convention
  (e.g. `server/http.mjs:1732` for `POST /api/public-work/match`,
  `server/http.mjs:1729` for `/api/public/rooms/directory`) and RFC 9110 §15.5.6
  (resource exists, method unsupported → 405, not 404).
- **Repro**: `node worker-6/repro-405.mjs` → PUT/PATCH/DELETE/OPTIONS/HEAD → 404.
- **Fail-first test**: `worker-6/wave2000-worker6-405.test.mjs` — currently RED (404 !== 405);
  fix = add a method guard for the route returning 405, should turn green.
- Impact: low (clients misreading 404 as "endpoint gone"); consistency/contract issue only.

## Notes (not findings)
- `rate()` runs before body validation on both routes, so malformed requests consume the
  per-account / per-IP rate budget. By design (rate-before-parse), self-inflicted only.
- Anonymous `POST /api/public-work/match {}` → 200 with volunteer-task recommendations;
  a well-formed but unknown Bearer token → 401 `unauthenticated`. Defensible.
- No node_modules present in the worktree; server boots and all tests ran without it.
