# WORKER 27 — shard report (index mod 50 == 26)

Shard routes (from `worker-list.txt`, sorted route-handler list):
- **A:** `POST /api/auth/agent/rooms` — server/http.mjs:2614 (agent browser sign-in: verify identity secret, list linked rooms)
- **B:** `POST /api/share-links/join` — server/http.mjs:2569 (join a room through a human invitation link)

## Method
Local API fuzzing against the acceptance fixture (`scripts/acceptance-fixture.mjs`
+ `createRoomServer`), fresh boot per batch to keep the in-memory rate buckets
fresh. 85 fetch cases + raw-socket probes + a timing follow-up + a replay follow-up.

Harness: `fuzz.mjs` (main matrix), `followup.mjs` (timing + raw with correct Host),
`raw.mjs` (raw transport paths), `replay.mjs` (documented idempotent replay).
Results: `results.json`, `timing.json`, logs `run.log` / `followup.log`.

## Findings

### W27-01 — wrong-method returns 404 instead of 405 (minor, ADVISORY)
`GET/PUT/DELETE/PATCH/HEAD/OPTIONS` on either route → `404 not_found`, no
`Allow` header. Sibling POST-only routes in the same file have explicit 405
guards whose comment states the design intent ("a wrong method is 405
(Allow: POST), not a 404 unknown-route"). Not a doc violation (openapi.yaml
documents no 405 here), no security impact.
- Minimal repro: `repro-405.md`
- Fail-first test: `method-405.test.js` — currently FAILS (`expected 405, got 404`); passes once 405 guards land.

### Clean (no finding)
- **Auth matrix (A):** valid → 200 with `{identityId, displayName, rooms}`; missing
  bearer → 401; malformed `Authorization` (short/basic/empty-scheme) → 401
  "Invalid Authorization header"; wrong secret → 401; mismatched
  identityId/secret → 401; lowercase `bearer` scheme works (RFC 7235).
- **Origin matrix (A, B):** missing/wrong/`null`/trailing-slash/no-port/uppercase
  origins → 403 `origin_denied`; correct origin required even with a bearer
  credential (stricter than the bearer-waiver routes — matches the openapi note
  "`Origin` checked").
- **Body matrix (A):** `{}`/extra-keys/non-string identityId → 422 `invalid_login`;
  array/scalar/empty/non-JSON → 400 `invalid_json`; `text/plain` → 415;
  charset-suffixed and uppercase `application/json` accepted; duplicate JSON keys
  last-wins; `__proto__` key → 422 (exact key-set check); 10000-char id → 401;
  NUL/unicode/whitespace ids → 401.
- **Pre-auth matrix (B):** no cookie / garbage cookie → 401 "Invalid account
  session slot"; valid slot without/bad CSRF → 403 `csrf_denied`; missing
  session binding → 422 `session_binding_required`.
- **Body matrix (B):** missing/extra fields → 422; bogus/SQL/NUL/long linkToken →
  410 `link_unavailable`; empty/81+-char name → 422; malformed UUID redemptionId
  → 422; non-integer/negative/huge revision → 422; revision mismatch → 409
  `session_binding_changed`; cross-session redemption replay → 409
  `join_session_lost`.
- **Happy paths:** mint identity → 201; A valid → 200; B join → 201 (guest
  account minted, session rotated); same-redemptionId retry with rotated session
  → 200 `duplicate:true` (idempotent, as documented); second redemptionId from
  same session → 200 `duplicate:true` via membership reuse (no double guest).
- **Raw transport:** declared 99999999-byte body → immediate 413 `too_large`;
  200KB body → 413 naming actual size; missing Content-Type → 415; chunked /
  negative / CL+chunked → 400 at the node layer; incomplete trickle → server
  holds until its own timeout (expected); `Host: evil.example` → 403
  `host_denied` up front.
- **Timing:** no oracle — valid/wrong/nonexistent/whitespace/empty/mismatched
  identityIds all land in overlapping 40–150ms bands across 6 reps (an initial
  852ms single sample was cold-start noise).
- **Status census (85 cases):** 200×7, 201×9, 400×3, 401×13, 403×11, 404×12,
  409×3, 410×5, 415×1, 422×17 — zero 500s, zero hangs, zero stack traces in
  response bodies.

## Files
- `fuzz.mjs` — main fuzz matrix (85 cases across 9 batches)
- `followup.mjs` — timing-oracle probe + raw probes (first pass)
- `raw.mjs` — raw-socket transport probes (fresh boot)
- `replay.mjs` — documented idempotent-replay verification
- `results.json`, `timing.json` — machine-readable results
- `run.log`, `followup.log` — console logs
- `repro-405.md` — minimal repro for W27-01
- `method-405.test.js` — fail-first test for W27-01 (FAILS now, as intended)

## Status
Shard complete. 1 minor advisory finding (W27-01, fail-first test included).
No crashes, hangs, 500s, or leaks found on either route. No git commit made
(per task rules); nothing pushed; zero room posts.
