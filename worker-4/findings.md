# WORKER 4 — fuzz findings (WAVE-2000 G02)

Target: local server only (`http://127.0.0.1:44217`), never production.
All statuses below were observed live; server stayed up throughout.

## Handler A — GET /api/auth/google/start (server/http.mjs:1106)

| Case | Result | Assessment |
|------|--------|------------|
| Baseline GET (unconfigured) | 503 `google_not_configured` (JSON); 302 `/?google=unavailable` with `Accept: text/html` | correct |
| Baseline GET (configured) | 302 → `https://accounts.google.com/o/oauth2/v2/auth?...` + fresh `account_session` cookie | correct |
| POST/PUT/DELETE/PATCH/OPTIONS/HEAD | 405 `method_not_allowed` | correct |
| Unknown method (FROB, raw) | 400 empty body | **not app code** — Node's llhttp rejects unknown methods at parse level (verified against bare `node:http` server) |
| Lowercase `get` via node client | 302 | **harness artifact** — node's HTTP client uppercases known methods before sending (verified: wire method was `GET`) |
| Trailing slash `/start/` | normalized → 302/503 | correct (up-front normalization) |
| `//api//auth//google//start`, encoded `%2f`, uppercase path | 404 | correct |
| 8k query, 300 query params, 200-emoji query | 503 (unconfigured) / 302 (configured) | no crash, no hang |
| Huge/garbage/dup/empty/stale `account_session` cookie | 302 fresh slot; dup → 401 `ambiguous_session_cookie` | correct |
| 8k Cookie, 12k Accept, X-Forwarded-For ×500, 5k Bearer | 503/302, no crash | correct (proxy headers ignored; `trustedLocalProxy=false`) |
| Rate hammer 25× (configured) | 3× 302 then 22× 429 | correct — 10/min per IP |
| Pending-state flood 110× fresh slots | all 429 (rate limiter) | correct; global 100-cap in `store.oauthPendingStateCreate` returns 429 `oauth_busy` (server/store.mjs:2932), never 500 |
| Raw: bad `%zz`, null byte, space in path, HTTP/9.9 | 404 / 400 / 400 / 400 | correct |
| Raw: giant header line (20k) | 431 | correct (Node limit) |
| Raw: HTTP/1.0 without Host | 403 `host_denied` | acceptable (strict host check) |
| Raw: truncated headers | server waits (headersTimeout) | expected, guarded by `server.requestTimeout = 15000` |

## Handler B — POST /api/guest-agent-links (server/http.mjs:2419)

| Case | Result | Assessment |
|------|--------|------------|
| No Origin header | 403 `origin_denied` ("Origin header is required") | correct — `checkOrigin(req, !carriesBearer(req))` |
| No credential (+Origin) | 401 `unauthenticated` — before body parse; 15k roomId / 50k chunked bodies don't crash | correct |
| `?auth=bogus`, `?auth=ROOM` | 422 `invalid_auth_mode` | correct |
| `Bearer not-a-real-token!!` (±Origin) | 401 (invalid Authorization header); Origin not required with bearer | correct |
| GET / HEAD | 200 contract JSON | correct |
| PUT / DELETE | 404 (no explicit 405 branch, unlike some sibling routes) | minor inconsistency, not a defect — undefined method+path → generic 404 |

## Shared body() via POST /api/guest-agent-links/preview (server/http.mjs:843)

| Case | Result | Assessment |
|------|--------|------------|
| Malformed JSON | 400 `invalid_json` | correct |
| Array / string / number / null body | 400 `invalid_json` | correct |
| Missing Content-Type | 415 `json_required` | correct |
| `{}` / wrong shapes | 422 `invalid_link` | correct |
| `linkToken` non-string / bogus / 15k | 410 `link_unavailable` | correct (store lookup) |
| Declared Content-Length 99999 | 413 `too_large` naming actual vs limit | correct (G7 behavior) |
| Streamed 30k body, no declared length | 413 `too_large` after drain | correct |
| 1000-deep nesting | 422 (parsed, then `exact()` rejects) | correct — no stack overflow |
| Duplicate Content-Length | 400 (llhttp) | correct |

## Investigated and cleared (not bugs)

1. **`ERR: socket hang up` on huge-body cases (first fuzzer round).** Root cause: my
   harness reused keep-alive sockets after sending `Content-Length: 100000` with an
   empty body; the server had already destroyed those sockets. Re-ran with fresh
   connections (`agent: false`): oversize stream → clean 413, huge unauthenticated
   POST → clean 401. No server defect.
2. **`google_connection_busy` 500 path.** `GoogleSignIn.begin()` throws
   `GoogleOAuthError('google_connection_busy')` at 100 in-memory pending entries, which
   `http.mjs` does not map (→ 500 `internal_error`). Unreachable through the real
   server: `http.mjs` always supplies the persistent `pendingStore`, whose
   `oauthPendingStateCreate` enforces the same 100-cap with a proper 429 `oauth_busy`.
   Only affects hypothetical non-`http.mjs` embeddings. No change proposed.

## Fail-first tests

None written — the mission ties tests to findings (crash/hang/wrong-status), and the
shard produced zero findings. The behaviors above (405/401/403/413/422/429 gates,
cookie ambiguity, rate limits) are already covered by the repo's existing suites.
