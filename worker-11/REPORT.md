# WAVE-2000 guild-02 — WORKER 11 report (shard 11/50)

**Shard spec adaptation:** the launcher's literal `grep -nE 'app\.(get|post|put|patch|delete|use)\('`
matches 0 lines in `server/http.mjs` — this codebase routes via a monolithic `url.pathname`
dispatch chain (direct `if (url.pathname === …)` branches plus `/regex/.exec(url.pathname)`
branches). Enumerated all 244 dispatch branches in line order and took indices with
`(index mod 50) == 10`: **10, 60, 110, 160, 210**.

## Shard routes (fuzzed)

| idx | line | route |
|-----|------|-------|
| 10  | L1367 | `GET /.well-known/oauth-authorization-server` (OAuth discovery metadata) |
| 60  | L2286 | `POST /api/auth/methods/remove` (account-session login-method removal) |
| 110 | L3105 | `!=POST /api/access-requests` → 405 reject branch |
| 160 | L3417 | regex `/api/rooms/{id}/mentions/{eid}/ack` → POST-only mention ack (L4453) |
| 210 | L3513 | regex `/api/rooms/{id}/bounties` → escrow "list"/"create" (server/bounty-escrow-routes.mjs) |

## Fuzz coverage (~80 probes, 0 crashes, 0 hangs, 0 × 5xx)

- **Unauthenticated** (`fuzz-unauth.mjs` vs live server): 29 probes across all 5 routes —
  methods, garbage/missing/invalid-JSON bodies, oversized query, encoded path segments,
  overlong room ids, bad bearers. All responses were clean 2xx/4xx.
- **Authenticated** (`fuzz-auth.test.mjs`, 7/7 pass — in-process fixture server):
  - R160: ack own mention 200 + idempotent re-ack 200; nonexistent event 404;
    non-mention message 404; someone else's mention 403; GET/DELETE → 405;
    malformed/huge/array/text bodies (route ignores body) all 200.
  - R210: 16 list query fuzz (`group`/`viewer`/`poster`/`limit`/`status`/junk/encoded) —
    all 2xx/4xx, invalid enum values → 422; 20 create-body fuzz (nulls, strings-for-numbers,
    negatives, 1e30, bools, past/bad deadlines, deep nesting, 100KB title, array/string/empty/
    oversized bodies, missing content-type) — all 422 except `amount: 10.5` → 201 (fractional
    amounts intentional: millis precision, `server/bounty-escrow.mjs:578-583`); PUT → 405;
    fund on unknown id → 404.
- **Edge** (`fuzz-edge.test.mjs`, 3/3 pass): OPTIONS/PUT/PATCH/PROPFIND on R10 → 404 (no crash);
  R10 GET keeps 200 + JSON CT with odd Accept; R60 with valid Origin + no session → **401**
  (origin gate → session gate ordering correct), bad Origin → 403; R110 GET → 405 with
  `Allow: POST`.

## Findings (no crash — wrong-status nits; fail-first tests RED)

1. **405 responses omit the `Allow` header** (RFC 7231 §6.5.5 requires it):
   - `GET /api/rooms/{id}/mentions/{eid}/ack` → 405, no Allow (room-dispatch fallthrough, `server/http.mjs:4957`)
   - `PUT /api/rooms/{id}/bounties` → 405, no Allow (terminal reject, `server/bounty-escrow-routes.mjs`)
   - `GET /api/auth/methods/remove` → 405, no Allow (`server/http.mjs:2287`)
   - Inconsistent: `/api/access-requests` and `/api/updates` DO send `Allow`.
   - Locked by 3 RED fail-first tests in `worker-11/fuzz-findings.test.mjs` (fail on `allow` header absent).
2. **`HEAD /.well-known/oauth-authorization-server` → 404** while sibling
   `/.well-known/feedback` (L1389) accepts GET+HEAD — method-consistency nit; 405 would be
   more accurate than 404 for a GET-only branch. Not locked as a failing test (arguably by design).

Hardened paths confirmed: `body()` 16KB cap → 413, non-JSON CT → 415, non-object JSON → 400;
bounty query/body validation → 422; no credential oracle (bad room → 404 before auth check);
removeMethod fails closed on unknown ids.

## Files in `worker-11/`

- `REPORT.md` — this file
- `fuzz-unauth.mjs` — 29-probe unauth battery (+ `fuzz-unauth-results.json`, `fuzz-unauth.log`)
- `fuzz-auth.test.mjs` — 7 authenticated fuzz tests, all green (`fuzz-auth.log`)
- `fuzz-edge.test.mjs` — 3 edge tests, all green (`fuzz-edge.log`)
- `fuzz-findings.test.mjs` — 3 RED fail-first tests for the Allow-header finding (`fuzz-findings.log`)
- `server.log` — live-server boot log (server was SIGTERM'd twice by external cleanup; in-process tests unaffected)

No commits, no pushes, no PRs, no room posts, no prod touches.
