# WORKER 24 — API fuzzing report (shard 24/50, guild-02 slice: server/http.mjs)

## Shard definition
server/http.mjs has no `app.(get|post|…)` registrations — it is a hand-rolled
if-chain router. Shard = top-level `if (` dispatch conditions in the request
handler referencing routes (pathname / regex Match / `route ===`), sorted by
line number, 229 total. Worker 24 = indices ≡ 23 (mod 50) → 5 handlers:

| idx | line | handler |
|-----|------|---------|
| 23  | 1631 | `GET/HEAD /api/ready` |
| 73  | 2519 | `POST /api/guest-invites/rotate` |
| 123 | 4039 | `GET /api/rooms/{roomId}/capabilities` |
| 173 | 4529 | `GET /api/rooms/{roomId}/agent-pause` |
| 223 | 4880 | `POST /api/rooms/{roomId}/commands` |

Method: `createRoomServer` + `createAcceptanceFixture` in-process; fetch with
6s abort timeout (hang detection); liveness probe (`/api/health`) between
every case; server ran in the same process so a crash would have killed the run.

## Coverage: ~90 fuzz cases, 0 crashes, 0 hangs, 0 HTTP 500s

- **/api/ready**: GET→200, HEAD→200, POST→404, OPTIONS→404, junk query→200,
  `/API/READY`→404. Storage-unavailable path (503) not simulated.
- **/api/guest-invites/rotate**: auth runs before body parse (no-Bearer +
  bad body → 401, by design); valid-format bearer + malformed JSON → 400;
  + text/plain → 415; + `{}` → 422 invalid_guest_invite; roomId
  number/null/array/traversal/5000-char → 422; valid-format-but-unknown
  `ga1.` token → 401 "Session or key expired or revoked" (authenticate
  rejects before the 410 pattern gate); non-ga1 43-char token → 410
  invite_unavailable; no-Origin+no-Bearer → 403 origin_denied; HEAD → 404.
  10/min IP rate limit trips as designed (429 with Retry-After semantics).
- **capabilities / agent-pause (GET)**: unauthenticated → 401; unknown room →
  403 access_denied (deliberate — hides room existence from non-members);
  unknown/dup query params → 422; HEAD → 405 (handlers are GET-only by
  design; only /api/ready whitelists HEAD). `search=` with NUL/emoji/script
  payload → 200, no injection. 384-char roomId → 404 (validId caps at 128,
  deliberate not_found); 385-char → 404 (route regex cap).
- **commands (POST)**: malformed JSON → 400; text/plain → 415; null/array/
  string → 400; unknown type / numeric type / missing type / id-as-number /
  100KB type string / 1000-key data / data-as-string → 422 invalid_command;
  `__proto__` in data → 422 "Unexpected field: __proto__", `({}).pp_polluted`
  clean afterwards (no prototype pollution); nested `constructor` key →
  422 "Unexpected field: constructor"; nesting depth 5000 → 422, depth
  100000 → 413 (body cap, no stack overflow); 2MB body → 413 too_large;
  `?auth=bogus` ignored when valid Bearer <redacted> present; valid
  `message.posted` → 201, idempotent replay → 200; server alive after all runs.

## Findings: NONE
No crash, hang, or wrong-status response found on this shard. Every flagged
case during the runs traced to (a) my own wrong expectation, (b) deliberate
design (auth-before-parse, 403-for-unknown-room, GET-only 405s, rate limits),
or (c) a malformed payload bug in my own fuzzer (extra `}` → correct 400).
Per the mission (repro + fail-first test only on crash/hang/wrong-status),
no test file was added — there is nothing to guard.

## Files
- worker-24/fuzz.mjs — 66-case main pass
- worker-24/fuzz2.mjs — rotate pass under the rate limit (8s spacing)
- worker-24/fuzz3.mjs — commands deep edges (pollution, nesting, path lengths)
- worker-24/fuzz-results.json, fuzz2-results.json, fuzz3-results.json — raw results
- worker-24/worker-24.md — this report
