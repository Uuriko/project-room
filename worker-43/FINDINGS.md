# WAVE-2000 G02 — Worker 43 (shard 43) fuzz report

## Shard
Ordered `url.pathname` dispatch `if`s in `server/http.mjs` (the file uses a
pathname if-chain, not `app.get(...)` — no such call sites exist), 0-based
index mod 50 == 42:
- **idx 42** — `POST /api/account/ensure-default-room` (`server/http.mjs:2075`)
- **idx 92** — `POST /api/referral-invites/preview` (`server/http.mjs:3026`)

## Method
In-process server (`RoomStore` + `createRoomServer` on loopback, isolated
`worker-43/data/room.sqlite`). Three fuzz rounds, ~110 vectors total.
Raw results: `fuzz-results.json`, `fuzz-results-round2.json`,
`fuzz-results-round3.txt`. Harnesses: `fuzz.mjs`, `fuzz-round2.mjs`,
`fuzz-round3.mjs`.

## Handler B: POST /api/referral-invites/preview — 60 vectors, all correct
- Malformed tokens (empty, garbage, wrong prefix, bad base64, truncated,
  extra segments, non-JSON payload part) → **404 invite_unavailable**
- Structurally forged `ref1.*` tokens (bad signature, wrong tier/version,
  negative/float/string/huge depth, expired inverted times) → **404**
  (`verifyToken` never throws — fail-closed as documented)
- Wrong-typed token (null/number/object/array/bool) or missing/extra keys →
  **422 invalid_invite**
- Non-JSON / array / null / empty body → **400 invalid_json**;
  missing/wrong content-type → **415 json_required**
- GET/PUT/DELETE/HEAD → **405 method_not_allowed** (explicit branch)
- Bodies > 16384 bytes → **413 too_large** naming actual size and limit
  (100k token → 413 deterministically, 5/5 runs; 15,012B body → processed → 404)
- SQLi (`'; DROP TABLE referral_invites;--`), null bytes, emoji, unicode →
  **404**, table intact afterwards (parameterized queries)
- Rate burst: 20/min per address enforced; **429** on 21st, no 5xx ever

## Handler A: POST /api/account/ensure-default-room — 30 vectors, all correct
- No `X-Session-Binding` → **422 session_binding_required** (binding is
  mandatory before auth — by design, `accountBinding()`)
- Malformed binding → **422 invalid_session_binding**; valid binding + no/bad
  cookie → **401 unauthenticated**; well-formed but wrong binding → **409
  session_binding_changed** (all three layers verified)
- Full account signup over HTTP → first call **201** (room created,
  `created:true`, `personal-<id>`), repeat → **200 idempotent**
  (`created:false`); arbitrary JSON body ignored (never read) → same 200
- Missing CSRF / bad CSRF / missing Origin → **403** (`protectWrite`)
- GET/PUT/HEAD → **404 not_found** (only `post:` is in `docs/openapi.yaml`
  line 11015 — matches spec)
- Duplicate `account_session` cookies → **401 ambiguous_session_cookie**;
  `xaccount_session=` does not false-match → 401
- 20k-char cookie → **431** (node http layer, before app code)

## Findings
**None.** Zero crashes, zero hangs, zero wrong statuses across all vectors.
Every "MISS" in round 1 was a wrong expectation in the harness (rate-window
pollution; binding-required 422s; 100k token is over the 16KB body cap →
413), all re-verified clean in rounds 2–3. No fail-first test was warranted;
existing coverage already guards both endpoints
(`tests/default-room.test.js`, `tests/referral-invites.test.js`,
`tests/invite-only-boundary.test.js:161`).

## Notes
- Round-1 console showed one irreproducible `429` for the 100k-token vector;
  the run's own `fuzz-results.json` recorded **413**, and round 2 + round 3
  (7 total runs) all returned **413**. Treated as a display artifact, not a
  server behavior.
- No crashes/hangs observed; no server process left running.
