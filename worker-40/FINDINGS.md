# WORKER 40 findings — WAVE-2000 GUILD-02

Shard: `GET|HEAD /agents` (server/http.mjs:1972), `POST /api/agent-invites/redeem` (server/http.mjs:2940).
Method: local acceptance-fixture server on 127.0.0.1; 35 surface cases + 15 deep-path cases
with real scrypt-hashed invite rows inserted into the fixture DB.

## Verdict: NO REAL FINDINGS — 0 crashes, 0 hangs, 0 500s, 0 stack leaks, 0 wrong statuses.

### GET /agents (15 cases, fuzz40.mjs batch A)
- 200 for GET/HEAD; 405 for POST/PUT/DELETE; 422 invalid_cursor for garbage/SQLi/null-byte/unicode/array/4000-char cursors; empty cursor → 200; ref XSS probe reflected escaped only; `/agents.json` → 200 agents.json spec (intended); `/AGENTS` → 404. All as designed.

### POST /api/agent-invites/redeem (20 cases, fuzz40.mjs batch B + fuzz40-deep.mjs)
- Method/body guards: GET/PUT → 405, missing content-type → 415, empty/truncated/array/null/string JSON → 400, missing fields / wrong types / extra fields → 422, declared-oversize body → 413.
- With live codes: valid → 201; re-redeem → 409; expired/revoked → 410; already-used → 409; 81-char name → 422 invalid_invite_name; 80-char → 201; lowercase/padded/confusable-folded codes normalize and redeem (201); bogus bearer identity → 401.
- 5-way concurrent redeem of one code: exactly one 201 + four 409s — the compare-and-swap burn (`UPDATE ... WHERE redeemed_at IS NULL`) is race-safe.
- The redeem response deliberately omits the identity secret (by design, agent-invites.mjs), so the same-identity rejoin path is not reachable via pure HTTP fuzzing — noted, not a gap in the API surface.

### Dismissed candidate
- D09: whitespace displayName → 422 on a boot where an earlier case had already taken the default name "Invited agent". In isolation → 201 with displayName "Invited agent". Correct name-collision behavior (422 display_name_unavailable + suggestion), not a bug. Harness expectation error.

### Artifacts
- fuzz40.mjs — surface battery (35 cases, 4 boots to stay under rate limits)
- fuzz40-deep.mjs — live-code battery + concurrency race
- probe_agentsjson.mjs, confirm-d09.mjs — one-off probes
- results.json, results-deep.json — raw results
- No fail-first test written: nothing failed.
