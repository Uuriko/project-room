# WAVE-2000 guild-02 — worker 39 (shard 38/50) report

## Shard
`server/http.mjs` has no `app.get/post/...` router — it is a raw `node:http`
pathname-dispatch server. Shard adapted: 110 sorted `url.pathname` branch
conditions, index mod 50 == 38 →
- **#38** `POST /api/auth/agent/session` (http.mjs:2627) — agent browser sign-in
- **#88** `POST /api/share-links/join-agent` (http.mjs:2536) — agent share-link join

## Method
Local server on 127.0.0.1:45139, throwaway sqlite (`$worktree/.tmp/fuzz39.sqlite`).
Node fuzzer (`fuzz-shard39.mjs`, 54 cases, 15s hang timeouts, rate-window pacing):
auth variants (missing/garbage/`rak_` room-token/mismatched bearer), body variants
(malformed JSON, array, empty, >16KB oversize, wrong content-type), field mutations
(number/null/bool/array/object/empty/huge/unicode tokens; blank/81-char/80-char/
100KB/control-char/newline displayNames; missing/extra keys), origin variants
(missing/wrong/forged, with and without bearer), and method variants (GET/OPTIONS).

## Result
**54/54 pass. Zero crashes (no 5xx), zero hangs, zero wrong statuses.**
Verified behaviors: 201/200 happy paths + duplicate join, 401 on every bad-credential
shape, 422 on bad field shapes, 400 malformed JSON, 415 wrong content-type,
413 oversize body, 403 origin-denied, 410 dead invite link, 405 GET/OPTIONS on
join-agent, 404 unknown room on agent/session, 403 unlinked room.

## Findings
None requiring a fix:
1. `GET /api/auth/agent/session` → **404** (no 405 twin). join-agent has an explicit
   405 twin with a comment explaining the intent; agent/session falls through to
   the unknown-route 404. Inconsistent within the file, but matches the room's
   general convention — observation only, not filed as a bug.
2. Control characters in join-agent `displayName`: initially suspected a validation
   gap vs `/join` + `/api/agent-identities` (RC-2026-09-19-086). Repro
   (`repro-control-char.mjs`) disproves it — first join with `\u0001` in the name
   returns **422 `display_name_unavailable`** ("contains hidden or control
   characters") via `assertAdmissibleMemberName`. Consistent. No bug.
3. `checkOrigin(req, true)` on agent/session requires Origin even with a valid
   bearer (unlike join-agent's bearer waiver) — by design (browser sign-in route).

No fail-first test written: there is no failing behavior to guard.

## Files
- `worker-39/fuzz-shard39.mjs` — the fuzzer (re-runnable)
- `worker-39/repro-control-char.mjs` — targeted control-char repro
- `worker-39/results.json` — 54-case machine-readable results
- `worker-39/fuzz.log` — full run log
- `worker-39/report.md` — this report
