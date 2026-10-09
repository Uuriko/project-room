# WORKER 13 findings — WAVE-2000 guild-02 (server/http.mjs API fuzzing)

Shard: dispatch blocks in `server/http.mjs` sorted by line, 0-based index % 50 == 12.
Note: this file uses raw `node:http` with `if (url.pathname …)` dispatch blocks —
there are no express-style `app.get/post(…)` calls, so the shard is defined over the
111 dispatch blocks. Mine:
- block #13 — `POST /api/auth/email/verify/resend` (server/http.mjs:1214)
- block #63 — `GET /api/account/retention` (server/http.mjs:2381)

## Method
Local server on 127.0.0.1:49113 (scratch sqlite). Minted 3 fixture accounts via
`store` directly (acct-noemail, acct-unverified, acct-verified) + session
token/csrf for each. 42 fetch probes + 9 raw-socket probes + 10-way concurrency
probe. Then a route-level test file exercising the mailer-configured success path
via `createRoomServer({ magicLinkMailer })` injection (unreachable from server.mjs,
which leaves the seam unconfigured).

## Result: NO crash, NO hang, NO wrong-status on either endpoint
- 42/42 fetch probes pass; 9/9 raw-socket probes pass (after correcting 3
  expectations — see notes); 5/5 route tests pass.
- Auth chain correct on both: 405 wrong method → 403 origin (resend requires
  Origin; retention relies on the global gate at http.mjs:1020) → 401
  no/bad/ambiguous cookie → 403 bad/missing CSRF (resend) → 429 after 5
  per-account resends/min (per-account isolation verified; X-RateLimit-*
  headers present on 429; concurrency split exactly 5 admitted / 5 rejected
  in a fresh window).
- Resend state machine: no-email → 422 `invalid_email`; verified → 200
  `already_verified`; unverified + unconfigured mailer → 503
  `mail_not_configured`; configured mailer → 200 `resent` + 6-digit code
  issued + `sendMagicLink({to, code, expiresAt, purpose:"email-verify"})`.
- Delivery throw inside `sendMagicLink` is swallowed by `deliverSignupMail` and
  still answers 200 `resent` — this is documented intent in the code comment
  ("Delivery failures do not change the resend response"), not a bug.
- Unread-body safety: declared `Content-Length: 100000000` with no body,
  never-ending chunked body, and pipelined requests after an unread body all
  get immediate responses; keep-alive pipelining serves both responses
  correctly (200,200) with no desync. Wrong Host → 403 `host_denied`;
  `//` target → 400 `invalid_request`; 20KB header → 431; `%2e%2e`/`%00`
  paths → 404; duplicate Origin headers → 403.
- `normalizeEmail` never throws (null → 422); CSRF compare is length-safe
  (`bindingPattern` is fixed 64-hex, same as real csrf).
- `GET /api/account/retention`: 405 on non-GET, 401 unauthenticated,
  200 `{policy:{version:"1.5.0",…}}` otherwise. Trivially correct.

## Test-coverage gap found (no bug, but worth promoting)
No existing test touches `POST /api/auth/email/verify/resend` (only the
mailer seam in `tests/resend-mailer.test.js`). New regression file:
`worker-13/resend-route.test.mjs` — 5/5 green via `node --test`. Recommend the
integrator promote it to `tests/` (rename to `tests/email-verify-resend-route.test.mjs`).

## Files (all under ~/workspace/pr-wave2000-guild-02/worker-13/)
- shard.txt, shard-handlers-all.txt — shard definition
- fuzz.mjs, fuzz-results.json — 42 fetch probes
- fuzz-raw.mjs, fuzz-raw2.mjs, fuzz-raw-results.json, fuzz-raw2-results.json — 9 raw-socket probes
- mint-fixtures.mjs, fixtures.json — fixture sessions (local test tokens; scratch DB only)
- resend-route.test.mjs — 5 route tests, all green
- server.log — fuzz server log
