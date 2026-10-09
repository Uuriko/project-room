# WORKER 42 — shard 42/50 report (WAVE-2000 guild-02)

## Shard
`server/http.mjs` uses manual `url.pathname` dispatch (no `app.get(...)` calls),
so the shard universe was the 93 pathname-dispatch clauses in source order;
clauses with (0-based index mod 50) == 41:

1. `POST /api/auth/methods/enable` — server/http.mjs:2277
2. `GET|HEAD /api/updates` — server/http.mjs:3170

## Method
Authenticated deep-fuzz (the guild's generic sweep covers unauthenticated
traffic; these handlers' interesting code sits behind auth). Booted local
server from `createAcceptanceFixture()` + `createRoomServer()` on 127.0.0.1;
minted account sessions (cookie+CSRF+binding) and identity secrets at the
store level. ~100 cases across `worker-42/fuzz-shard42.mjs` and
`worker-42/fuzz-shard42-c.mjs`; every request had an 8s hang timeout; bodies
scanned for stack/secret leaks. Findings auto-logged to
`worker-42/findings.json`.

Coverage: body-shape matrix (null/array/number/empty/extra-keys/dup-keys/
proto-pollution/5k-id/unicode/control-char), transport bodies (text/plain,
empty, `null` literal, truncated, 600-deep nest, 20k oversize → 413,
invalid-UTF8, empty content-type), method matrix (GET/PUT/DELETE/PATCH/
OPTIONS → 405), auth matrix (no/bogus cookie → 401, dup cookie → 401,
missing/wrong/short CSRF → 403, missing/evil Origin → 403), Bearer <redacted> on
cookie route (ignored, 200), re-enable disabled method (200), limit matrix
(`0,-1,abc,"",1.5,101,>2^63,Infinity,NaN` → 422; `0x10,+5," 5",1e2,007` → 200;
`1_0` → 422), state/kinds/cursor matrices (→ 422 on junk, 409 `cursor_stale`
on well-formed unknown cursor, 422 on wrong-viewer cursor), dup/unknown
params (→ 422; `?auth=x` allowed-but-ignored → 200), binding via header vs
query (mismatch/dup/malformed → 422; absent → 422 `session_binding_required`;
wrong-but-well-formed → 409 `session_binding_changed`), HEAD → 200,
POST → 405 with `Allow: GET`, 8k query → 422, null-byte limit → 422,
malformed Authorization + valid cookie → strict 401.

## Findings
**No crashes, no hangs, no 500s, no wrong statuses, no secret/stack leaks.**
8 auto-flags triaged as false positives:
- A17/A19: my expectations were wrong, not the code — 600-deep *valid* JSON
  parses fine and correctly yields 422 `invalid_method`; invalid-UTF8 bytes
  that still decode to parseable JSON correctly yield 404
  `login_method_not_found`.
- A25–A27/B1/B3: leak-regex false positives — responses contain the literal
  words "csrf"/"secret" only inside error codes/messages (`csrf_denied`,
  "Identity secret or account session required"); no secret values echoed.
- B6: 409 `session_binding_changed` on a wrong-but-well-formed binding is
  intentional (server/store.mjs:3131; special-cased at server/http.mjs:904),
  not a wrong status.

Per mission ("crash/hang/wrong-status → minimal repro + fail-first test"),
no fail-first test was written because no defect was found.

## Files
- worker-42/fuzz-shard42.mjs — main authenticated fuzz (batches A + B)
- worker-42/fuzz-shard42-c.mjs — edge probes batch C (8/8 as expected)
- worker-42/findings.json — 8 triaged false-positive records
- worker-42/SUMMARY.md — this file
