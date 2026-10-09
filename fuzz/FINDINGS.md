# WAVE-2000 GUILD-02 findings — API fuzzing of server/http.mjs

Slice: `server/http.mjs` (5035 lines @ 747f101f8, ~88 literal routes + regex dispatch).
Method: local-only fuzzing (127.0.0.1, acceptance fixture). 50 route-group
targets × adversarial cases (malformed JSON, oversized bodies, wrong methods,
null bytes, adversarial headers/querystrings, raw-socket HTTP abuses,
slow-drip/abort, encoding edges) + directed probes. 0 server crashes, 0 hangs.

## FUZZ-009 (worker-49) — `?auth=<invalid>` silently accepted when a Bearer <redacted> is present

- **Location:** `server/http.mjs` `roomCredentials()` (~L731).
- **Cause:** the bearer early-return (`if (bearerToken) return {...mode:"room"}`)
  skips the `auth` selector validation. `?auth=bogus` without bearer → 422
  `invalid_auth_mode` (correct); with `Authorization: Bearer <redacted>` →
  200, invalid input silently ignored. No auth bypass (bearer forces room
  mode) — strictness/contract issue only.
- **Severity:** low.
- **Fail-first regression test:** `worker-49/authmode.test.js`
  (fails on current code: 200 !== 422). Full report: `worker-49/FINDINGS.md`.

## FUZZ-008 (worker-7, platform caveat) — configured requestTimeout=15000 not honored on incomplete chunked bodies

- **Location:** `server/http.mjs` L5029 (`server.requestTimeout = 15000`).
- **Observation:** an incomplete chunked-body POST stayed open 23-30s before
  the 408 arrived. Bare-Node 24 calibration shows Node itself doesn't enforce
  sub-~30s `requestTimeout` promptly in this version — platform behavior, not
  app code. Impact: slowloris-class but eventually bounded; the configured
  15s is misleading to operators.
- **Severity:** low. Possible hardening: app-level watchdog on body reads
  (`server/http.mjs:820`).
- **Fail-first regression test:**
  `worker-7/wave2000-worker7-slowbody-timeout.test.mjs`.
  Full report: `worker-7/README.md`.

## FUZZ-007 (worker-12, CROSS-SLICE) — normalizeEmail accepts ASCII control chars

- **Location:** `server/account-login-methods.mjs:129` (**not** this slice —
  guild 13's auth slice; surfaced by this guild's fuzzing of the
  magic-link request path).
- **Cause:** the whitespace check uses `\s`, which doesn't match NUL/ESC/BEL,
  so control chars survive into the magic-link recipient / lookup key.
  Repro: `POST /api/auth/magic/request {"email":"a\x00@b.co"}` passes
  validation (200 mail_not_configured in test env).
- **Severity:** low.
- **Fail-first regression test:**
  `worker-12/email-control-chars.failfirst.test.mjs` (fails on current code).
  Full report: `worker-12/SHARD12-SUMMARY.md`.

## FUZZ-006 (CONFIRMED, worker-2 + 4 more workers) — 405 responses missing or incomplete `Allow` headers

- **Cause:** RFC 9110 §15.5.6 requires `Allow` on 405; several dispatch
  sites omit it or list incomplete methods while ~66 sibling sites do it right.
- **Instances (all in this slice unless noted):**
  - `POST /api/auth/github/link/start` → 405, no Allow (worker-2, F-W2-01;
    independently re-verified). Test: `worker-2/regress.test.mjs`.
  - `GET /openapi.json` (wrong method) → 405, no Allow (worker-25;
    `worker-25/openapi-allow-header.test.js`; worker-25's one-line fix was
    reverted to keep the branch findings+tests-only — see `worker-25/REPORT.md`).
  - `POST /api/updates` (wrong method) → 405 with `Allow: "GET"` but the
    route serves GET **and** HEAD (`server/http.mjs` L3179 vs L3181) —
    Allow omits HEAD (worker-1; fail-first test red).
  - `GET /api/rooms/{id}/mentions/{eid}/ack` → 405, no Allow (L4957);
    `GET /api/auth/methods/remove` → 405, no Allow (L2287) (worker-11;
    3 RED fail-first tests in `worker-11/fuzz-findings.test.mjs`).
  - `PUT /api/rooms/{id}/bounties` → 405, no Allow — root cause in
    `server/bounty-escrow-routes.mjs` (cross-slice, guild 03 territory;
    worker-11).
- **Severity:** very low / cosmetic.

## FUZZ-005 (worker-44) — invalid-UTF8 JSON bodies lossy-decoded to U+FFFD and stored (200), should be 400

- **Location:** `server/http.mjs` L835 (`readText`):
  `Buffer.concat(chunks).toString("utf8")` replaces bad bytes with U+FFFD.
- **Cause:** a JSON body containing raw invalid-UTF8 bytes (e.g. `0xff 0xfe
  0x80` inside a string field) decodes lossy and passes validation; the
  request returns 200 and persists mojibake (`"\ufffd\ufffd\ufffd"`).
  Strict contract would be 400 `invalid_json` like every other body-parse error.
- **Severity:** low / data-integrity soft finding. Judgment call whether to
  harden `readText` with a fatal UTF-8 decode (e.g. `TextDecoder("utf-8",
  { fatal: true })`).
- **Fail-first regression test:** `worker-44/failfirst-utf8.test.js`
  (red on current code). Full report: `worker-44/FINDINGS.md`.
  Note: observed via `server/routes/*` handlers (guild 03 slice) but the
  root cause is the shared `readText` in this slice.

## FUZZ-004 (CONFIRMED, worker-29) — wrong methods on /api/account-rooms return 404 instead of 405

- **Location:** `server/http.mjs` L2049 (`/api/account-rooms`).
- **Cause:** the handler matches `req.method === "POST"` only; other
  methods fall through to the generic 404. Sibling routes carry explicit
  405 guards with `Allow` headers (`/api/referral-invites/preview` L3032,
  `/api/public/rooms/directory` L1729, `/api/opportunities.json` L1829).
- **Severity:** very low / cosmetic inconsistency (independently re-verified
  2026-10-09: PUT/PATCH/DELETE/HEAD → 404).
- **Fail-first regression test:** `worker-29/account-rooms-405.test.mjs`.
  Full report: `worker-29/REPORT.md`. Independently corroborated by
  worker-6 (W6-01, `worker-6/wave2000-worker6-405.test.mjs`, also RED),
  worker-21 (same pattern on `GET /api/agent-invites/preview`:
  POST/PUT/DELETE → 404; `worker-21/agent-invites-preview-method.test.mjs`,
  2 fail / 1 control passes), and worker-27 (W27-01 on
  `POST /api/auth/agent/rooms` + `POST /api/share-links/join`;
  `worker-27/method-405.test.js` fails as intended). Pattern: ~66 dispatch
  sites answer 405 with `Allow`; these fall through to the generic 404.

## FUZZ-003 (CONFIRMED, worker-41, independently reproduced) — keep-alive request after a 413 is swallowed → socket hang up

- **Location:** `server/http.mjs` L821-822 (oversize fast-path) + L4989+
  (413 drain handler).
- **Cause:** a POST whose declared `Content-Length` exceeds the body cap
  throws 413 before the body is read; the 413 drain handler tries to keep
  the socket alive while draining the unread body. A client that legally
  pipelines its next request as soon as the 413 ends has those bytes
  consumed as body bytes; when the declared count is reached the socket is
  ended — the follow-up request is never parsed, client sees
  `socket hang up`. (With a 1.5s gap the same follow-up returns the correct
  status, so the 413 itself is correct.)
- **Severity:** low-medium. No data corruption; spurious connection error
  for legitimate keep-alive clients (Node 19+ default) that overshoot the
  cap and retry immediately. Deterministic 3/3 runs, two routes.
- **Fail-first regression test:** `worker-41/keepalive-413.test.mjs`
  (fails as designed — independently re-run 2026-10-09, got
  `REQ-ERR: socket hang up`). Minimal repro: `worker-41/repro-seq.mjs`.
  Full report: `worker-41/report.md`.
- **Recommended fix (not applied):** on 413 with an unread body, send
  `Connection: close` and close after draining instead of attempting
  keep-alive reuse.

## FUZZ-002 (CONFIRMED, worker-8) — POST /api/account/delete rate-limits before auth on a shared per-IP key

- **Location:** `server/http.mjs` L2401-2402.
- **Cause:** `rate(`account-delete:${remoteAddress}`, 5)` runs BEFORE
  `requireAccountSession()`. Five anonymous POSTs from one IP (only the
  site's own Origin needed — no session) burn the 5/min bucket for everyone
  behind that IP/NAT/VPN exit; a legitimate authenticated CSRF-valid delete
  then 429s for a minute. Sibling routes do it right:
  `GET /api/account/deletion/plan` (L2386) calls `requireAccountSession()`
  first; `POST /api/auth/email/verify/resend` (L1233) keys per-account
  after auth.
- **Severity:** low (1-minute lockout) but pre-auth and remotely triggerable
  on an irreversible-action route.
- **Fail-first regression test:** `worker-8/rate-limit-ordering.test.js`
  (fails as designed: 429 != 200). Full report: `worker-8/RESULTS.md`.
- **Recommended fix (not applied):** key the bucket on
  `session.account.id` after auth (mirror the resend route), or move
  `rate()` below `requireAccountSession()`.

## FUZZ-001 (CONFIRMED BUG) — POST /oauth/revoke returns 500 on missing/mistyped `token`

- **Location:** `server/http.mjs` ~L1591 (`if (url.pathname === "/oauth/revoke" ...)`).
- **Cause:** the handler calls `oauthProvider.revoke(data.token)` with no
  validation and no try/catch. A missing/non-string/empty `token` makes the
  provider's `check()` throw `OAuthProviderError` (`server/oauth-provider.mjs`
  L30-31, L334-335), which carries `.code` but no `.status`, so the http error
  boundary (`server/http.mjs` L4979: `error.status || 500`) maps it to **500**
  `invalid_request` / `internal` — a 500 wearing a 4xx code.
- **Minimal repro** (local server, acceptance fixture):
  `POST /oauth/revoke` `Content-Type: application/json` body `{}` → **500**
  `{"error":{"code":"invalid_request","message":"Service could not complete the request; no success is claimed"}}`
  Same 500 for `{"token":42}`, `{"token":null}`, `{"token":""}`, `{"token":["x"]}`.
- **Expected:** 400 `invalid_request` (malformed request). RFC 7009 leniency
  (200 for unknown tokens) already works for well-formed strings — verified
  `{"token":"nope-not-a-real-token"}` → 200. The sibling `/oauth/token`
  handler wraps provider calls in try/catch → 400; `/oauth/revoke` is the
  only unwrapped `oauthProvider.*` call in the file (L1591 vs L1421/L1500/L1555/L1563).
- **Fail-first regression test:** `tests/wave2000-guild02-oauth-revoke-fuzz.test.js`
  (2 tests fail against current code as designed; 2 lock in correct behavior).
- **Recommended fix (not applied — verification wave, no PRs):**
  validate before the call, e.g.
  `if (typeof data.token !== "string" || !data.token) reject(400, "invalid_request", "token is required");`

## Contested / notes

- **W41-001 vs worker-21:** worker-21 reproduced a 413-then-next-request
  hang-up in its first fuzz run but concluded "not a server bug" after an
  isolated repro with delay showed correct behavior. The distinction is
  timing: an immediate pipelined follow-up (legal — the 413 response is
  complete, the client cannot know the server is still draining) gets its
  bytes eaten; a delayed follow-up works. Worker-41's fail-first test
  (immediate pipeline) was independently re-run and deterministically
  reproduces the hang-up → kept as CONFIRMED.
- **404-vs-405 family (FUZZ-004):** worker-32 argues 404 is "the codebase's
  default for unhandled method+path combos; changing it alters public
  behavior." Kept as low/cosmetic inconsistency given ~66 sibling sites
  answer 405 with `Allow` (the codebase's own convention) — a merge-queue
  judgment call, not a crash.

## Verified-good (no findings)

- **50 fuzz targets, ~1,500 adversarial cases:** 0 crashes (health-probe
  restart never triggered), 0 hangs, 0 stack-trace leaks in responses.
- **Body limits:** 20KB/100KB/1MB oversized JSON → clean 413 `too_large`
  naming actual vs limit bytes (G7 #940 behavior intact); 8MB `/api/rooms/:id/import`
  reader behaves; declared-vs-actual content-length lies handled.
- **Method matrix** (PUT/DELETE/PATCH/OPTIONS/TRACE/PROPFIND) across 88
  literal routes: no 500s, no hangs.
- **Path-id boundaries:** 128-char ids accepted, 129-char rejected;
  `%2F`, `%00`, `..%2F` in ids → 404 (no traversal, no decode throw —
  `pathId()` fail-closed verified); 384/385-char roomIds handled.
- **/room alias differential** (22 routes × plain vs `/room` prefix):
  all `/room/api/*` pairs match; `/room/oauth/*` correctly 404s
  (alias covers `/room/api/*` only — probe artifact, not a bug).
- **Origin/CSRF:** foreign/missing Origin on POST → 403; 16KB headers,
  4KB bearer garbage, 16KB cookies, X-Forwarded-For chains → no 500s.
- **Raw-socket abuses:** bad request lines, 200KB header line (ECONNRESET/
  431 as node intends), double Content-Length, invalid chunked, HTTP/0.9 —
  server stays up throughout (expected node parser behavior; incomplete
  requests held to node timeout, not a leak).
- **Trailing-slash normalization:** `/api/health/` etc. reach routes (no 404
  misdirect); encoding edges (BOM, lone surrogates, invalid UTF-8,
  double-encoding) → 400/415, never 500.
- **OAuth sibling routes** (`/oauth/token`, `/oauth/authorize`,
  `/api/oauth/sessions*`): all validate-then-400 correctly under the same
  adversarial inputs.
- **Route aliases:** `/api/identity-create` ≡ `/api/agent-identities`
  (422/405 identical); `/room/api/*` ≡ `/api/*` (differential probe, 22 routes).

## Harness

- `fuzz/adversarial.mjs` — case generators (method matrix, JSON pathology,
  query/header attacks, raw-socket abuses, trickle/abort, encoding edges).
- `fuzz/targets.mjs` — 50 targets partitioning the http.mjs route surface.
- `fuzz/run.mjs` — runner with crash detection (health probe + restart).
- Raw findings JSON: `.tmp/findings-*.json` (not committed).
- Directed probes: `.tmp/probe-room-alias.mjs`, `.tmp/repro-revoke.mjs`
  (not committed; repro captured in the regression test).

## Notes

- The 50 launcher-spawned workers fuzz the same slice in shards; their
  results land in `worker-<k>/` and are integrated separately.
- BUG CONFIRMED room post withheld per launcher correction (single
  launcher rollup at wave end is the visible signal); finding preserved
  here and in the final report.
