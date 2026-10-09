# WORKER 38 — shard 37/50 — API fuzzing report

- **Shard**: route handlers in `server/http.mjs` (sorted `(path, method)` list, index % 50 == 37)
  - `POST /api/auth/password/set` (server/http.mjs:2295)
  - `GET|HEAD /api/updates` (server/http.mjs:3171)
- **Note**: the task's `app.(get|post|…)` grep finds zero handlers in this codebase —
  routes are `if (url.pathname === "…" && req.method === "…")` blocks plus a
  `dispatchRoute` prefix table. Shard was computed over the equivalent sorted
  handler list (114 handlers, shard 37 = the 2 above).
- **Harness**: `worker-38/fuzz38.mjs` — boots local server (127.0.0.1, acceptance
  fixture), mints auth material on the store (account session slot + CSRF +
  session binding; two `pri_`-prefixed identity secrets), runs adversarial cases
  in rate-limit-safe sub-batches (server reboot between batches resets the
  in-memory rate tables), health-probes after every batch, restarts on death.
- **Raw results**: `worker-38/results-38.json`

## Result: 141 cases, 141 passed, 0 findings, 0 crashes

No crash, no hang, no unexpected-500, no stack-trace leak, no wrong-status.

### Verified contract (all as designed)

**`POST /api/auth/password/set`**
- Method matrix: GET/HEAD/PUT/PATCH/DELETE/OPTIONS → 405 (TRACE not sent — undici
  client-side rejects TRACE; harness limitation, not server).
- No/wrong Origin → 403 `origin_denied`; valid Origin, no session → 401
  `account_session_required`; unknown session token → 401 `invalid_session`.
- Trailing slash `/api/auth/password/set/` → normalized up front (server/http.mjs:948-951,
  intentional QA 2026-10-03 P2-1 behavior) → reaches route → 401 without session. Not a bug.
- No/missing CSRF → 403 `csrf_denied`; wrong/short CSRF → 403.
- No content-type / text/plain → 415 `json_required`; `application/json; charset=utf-8`
  and `Application/JSON` accepted.
- Malformed/truncated/trailing-garbage JSON, top-level array/string/number/null/bool/empty →
  400 `invalid_json`; real invalid-UTF-8 bytes → decoded non-fatally to U+FFFD → 422 policy.
- Wrong types/null/array/object/empty/extra-keys/wrong-key → 422 `invalid_password_set`;
  9 chars → 422 `password_too_short`; 257 chars → 422 `password_too_long`;
  10/256-char boundaries pass policy.
- Duplicate JSON keys `{"password":"short","password":"<valid>"}` → last-wins, proceeds.
- Success path on fresh account with verified email method → **201**; replay → **409**
  `password_already_set`; weak-then-valid sequence → 422 then 201.
- Burst of 25 rapid authed POSTs → first 20 processed (422s on `{}`), then 429
  `rate_limited`; never 500, never a hang.

**`GET|HEAD /api/updates`**
- POST/PUT/PATCH/DELETE → 405 with `Allow: GET`.
- No auth → 401; malformed `Authorization` → 401 `Invalid Authorization header`;
  well-formed unknown secret (43-char and `pri_` forms) → 401 unknown/revoked;
  `bearer`/`BEARER` schemes accepted (RFC 7235).
- Valid identity secret → 200; HEAD → 200 with empty body.
- `limit`: abc/0/-5/101/1.5/empty/Infinity/huge → 422 `invalid_updates_query`;
  1/100/1e2/0x10/" 50 "/" +50 " → 200 (Number() coercion semantics).
- `state`: bogus/empty/ALL → 422; `all` → 200.
- `kinds`: bogus/REQUEST → 422; empty string → treated as absent → 200;
  `request,,mention,` → 200; 500-kind list → 200.
- `cursor`: garbage/wrong-viewer/wrong-version → 422 `invalid_cursor`; empty → 200.
- Unknown param / duplicated param → 422 `invalid_updates_query`; `auth=` param allowed, ignored.
- Account-cookie path: no binding → 422 `session_binding_required`;
  malformed/dup binding → 422 `invalid_session_binding`;
  valid binding via `X-Session-Binding` → 200; wrong-but-well-formed binding → 409
  `session_binding_changed`.
- Trailing slash `/api/updates/` → normalized → 401 without auth. Intended.

### False positives encountered and dismissed (harness artifacts, not product)
1. Early runs: 429s flagged as wrong-status — my sub-batches exceeded the
   `password-set` 20/min bucket; restructured to reboot between sub-batches.
2. `post-trailing-slash` expecting 404 — normalization is deliberate (see above).
3. `invalid-utf8` initially sent the literal 12-char string `\xff\xfe` (JS escape
   mis-level), which correctly 422'd on policy; re-ran with real invalid bytes.
4. undici refuses TRACE and control-byte cookie values client-side — dropped/replaced.

## Conclusion
Both shard-37 handlers are robust against the full adversarial matrix: auth checks
run before body/query parsing, every malformed input maps to a precise 4xx, rate
limits degrade to 429 (never 500/hang), and no response leaks stack traces.
**No fail-first test written — there is no finding to pin.** Existing coverage
(`tests/account-settings-http.test.js` for password/set; updates HTTP tests) already
guards the happy paths; the 422/405/429 contract matrix above is documented here
for the guild integrator.

## Files
- `worker-38/fuzz38.mjs` — shard fuzz harness (141 cases, 9 batches)
- `worker-38/results-38.json` — machine-readable results
- `worker-38/REPORT.md` — this file
