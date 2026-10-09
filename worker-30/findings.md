# Worker 30 — API fuzzing results (shard idx 29, 79)

Branch: wave2000/guild-02 @ 747f101f8. No source changes, no commits.

## idx29 — line 1925: GET/HEAD /join.html | /room/join.html (301 redirect)

| case | result | expected |
|---|---|---|
| GET /join.html | 301, Location: /join | 301 ✓ |
| HEAD /join.html, GET /room/join.html | 301 | 301 ✓ |
| GET /join.html?next=/room/x | 301, Location: /join?next=/room/x | 301 ✓ |
| GET /join.html?%0d%0aX-Injected:%201 | 301, Location: /join?%0d%0aX-Injected:%201 (percent-encoding preserved, single header line) | no injection ✓ |
| POST/PUT/DELETE /join.html | 404 (falls through; POST /join lives at line 2656) | ok |
| /JOIN.HTML, /join.html/, /join.html.html | 404 (exact-match dispatch) | ok |

No crash, no hang, no header injection. Nothing to report.

## idx79 — line 2899: POST /api/agent-identities | /api/identity-create (identity mint)

| case | result |
|---|---|
| valid {displayName} (fresh DB) | 201 mint |
| alias /api/identity-create | 201 (identical behavior) |
| missing/empty/non-string/array/object displayName | 422 invalid_identity |
| displayName >80 chars / C0 controls (server/agent-identities.mjs:326-330) | 422 invalid_identity |
| extra unknown field | 422 invalid_identity |
| empty body / null JSON / non-object JSON / malformed JSON | 400 invalid_json |
| no Content-Type: application/json | 415 json_required |
| body >16384 bytes (JSON_BODY_BYTES, server/http.mjs:260) | 413 too_large (deterministic; chunked and content-length both handled) |
| proof invalid chars / 44 chars / empty / non-string | 422 invalid_identity |
| recoverable:true without bearer | 401 unauthenticated |
| recoverable:false or recoverable:"yes" | 422 |
| deep-nest JSON (5000 levels) | handled, normal status |
| unicode/emoji/null-byte displayName | 422 (control-char rule) |
| GET/PUT/DELETE/OPTIONS on mint path | 405 method_not_allowed, Allow: POST |
| 45-request rapid burst | 428s then 429 rate_limited (30/min) — renders cleanly, server stays up |

PoW note: after the free-mint budget the route returns 428 proof_required with the
challenge params in the body (SHA-256 "{bucket}:{trimmedDisplayName}:{nonce}" must
start with proof.prefix) — by design, not a bug.

## Non-findings (investigated, NOT bugs)

1. Two transient ECONNRESETs in the first fuzz batch (proof-valid @ request ~35,
   10MB chunked body). Root cause: rapid-fire requests crossing the 30/min rate
   limit on short-lived connections. NOT reproducible in isolation — a clean
   45-request node burst returned 428/429 with zero resets; curl reproductions of
   both cases return 428 and 413 respectively. No server crash (process alive,
   health 200, no log anomalies).
2. A 200KB-displayName POST coincided twice with my background server process
   disappearing and port refusing. Re-investigated with fresh DBs and size sweep
   N=1000..200000: every oversized body returns deterministic 413, server stays
   alive ("server=alive" on all six sizes). The disappearances correlate with the
   runtime reaping backgrounded exec children between calls (scheduler ticks in
   server.log prove the process was healthy right up to reaping), not with the
   request. NOT a server bug.

## Verdict

No reproducible crash, hang, or wrong-status on either shard handler.
No fail-first test added (nothing to guard). No source changes.
