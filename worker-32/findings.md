# WORKER 32 findings — shard: server/http.mjs dispatch entries index%50==31

Shard (path-sorted pathname-dispatch list of 98 entries, per guild convention in worker-16/routes-all.txt):
- `32 1090 GET /api/auth/gmail/callback` — Gmail OAuth callback page (http.mjs:1090)
- `81 3181 HEAD /api/updates` — cross-room/account updates list (http.mjs:3171-3183; GET shares the block)

Harness: local server on 127.0.0.1 via `createRoomServer({store: fixture.store})` +
`createAcceptanceFixture()`; valid identity secret minted via `createAgentIdentity`.
Per-request 8s timeout; `/api/health` probe after every batch.

## Result: CLEAN — 62 adversarial requests, 0 crashes, 0 hangs, 0 wrong statuses

### A. GET /api/auth/gmail/callback (14 cases, fuzz-32.mjs)
- plain, `?code=&state=`, `?error=access_denied`, duplicate params, 4KB query,
  percent-junk (`%00%ff%zz`), junk/empty `gmail_oauth` cookie → all **200** with the
  `gmail=error` meta-refresh page (gmail bridge unconfigured locally — expected).
- `new URL(expectedOrigin() + url.pathname + url.search)` is Host-header-safe:
  `expectedOrigin()` (http.mjs:634) never reads the Host header.
- Non-GET methods (POST/PUT/DELETE/PATCH/HEAD/OPTIONS) → **404 fall-through**
  (no 405 guard on this path). OBSERVATION ONLY: sibling auth routes
  (`GOOGLE_START_PATH`, `GOOGLE_CALLBACK_PATH`, `/api/auth/email/verify`) all
  405 wrong-method requests; gmail callback is the odd one out. Not flagged as a
  bug — 404 is the codebase's default for unhandled method+path combos; changing it
  alters public behavior, out of fuzz-worker scope.

### B. /api/updates GET+HEAD (44 cases, fuzz-32.mjs / fuzz-32b.mjs / fuzz-32c.mjs)
- no auth, garbage bearer, unknown well-formed secret, wrong/missing auth scheme,
  garbage/empty `account_session` cookie → **401** (or **422** `session_binding_required`
  when the binding is absent — by design, binding is checked before token validity).
- valid identity secret → **200** GET and HEAD (HEAD has empty body).
- `?limit=` abc/-5/0/101/1.5/unsafe-int/empty/dup → **422**; `?limit=1`/`100` → 200.
- unknown param, dup allowed param → **422**; `?state=bogus` → 422; `?state=all` → 200.
- `?kinds=bogus` / `?kinds=mention,bogus` → 422; `?kinds=` / `?kinds=mention,` → 200.
- `?cursor=` garbage / missing-fields / wrong-viewer / 10KB → **422**.
- `?auth=` / `?binding=` allowed params → 200.
- POST/PUT/DELETE/OPTIONS/PATCH → **405** with `Allow: GET`.
- cookie auth with valid-format binding (header or `?binding=`) + garbage token → **401**
  `unauthenticated`; bad binding format or header/query mismatch → **422**
  `invalid_session_binding`.
- `/api/health` 200 after every batch; server process never died, no request hung.

## Fail-first tests
None written — no crash/hang/wrong-status was confirmed, so there is nothing to
encode as a failing test.

## Shard-definition caveat (for the verifier/integrator)
The launcher's shard spec (`grep -nE 'app\.(get|post|put|patch|delete|use)\('`) matches
**0** lines: this server is a plain `node:http` dispatcher (http.mjs:920), routes are
`url.pathname === ...` blocks delegated to handler modules. I followed the guild's
established convention (worker-16's path-sorted dispatch list, 0-based index%50==31).
If the launcher intended a different partition, shard 32's real coverage is the two
handlers above.
