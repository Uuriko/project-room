# WORKER 1 — API fuzzing report (WAVE-2000 guild-02)

Shard: sorted route-dispatch list in `server/http.mjs`, indices where `(index mod 50) == 0`
(102 dispatch patterns; the task's `app.get(...)` grep matches 0 lines — this
server dispatches on `if (url.pathname === ...)`; sharded on the real dispatch table).

| idx | route | http.mjs line |
|-----|-------|---------------|
| 0   | `/.well-known/security.txt` (+ `/security.txt`, `/room/.well-known/security.txt`) | 953 → `writeSecurityTxt` (167) |
| 50  | `/api/auth/github/link/start` | 2317 |
| 100 | `/api/updates` (GET/HEAD) | 3170 |

Method: local server booted from the shared worktree (`wave2000/guild-02` @ 747f101f8,
no commits); 71-case request battery (`fuzz.mjs`) covering method fuzzing
(GET/HEAD/POST/PUT/DELETE/PATCH/OPTIONS), path aliases, trailing-slash
normalization, case/dotdot variants, auth states (anon / garbage bearer /
valid identity secret minted via POST /api/agent-identities), and query
fuzzing (`limit`: abc/-1/0/1.5/huge/101/Infinity/empty/dup; unknown params;
`state` bogus/giant; `kinds` bogus/giant; `cursor` junk/wrong-shape).
Result: `fuzz-results.json` (71 cases, 70 pass, 1 transport-level non-finding).

## Finding (1, minor)

**`Allow` header on `/api/updates` 405 omits HEAD** — `server/http.mjs:3181`.
The resource accepts HEAD (200, verified with a valid identity secret), but the
405 handler advertises `Allow: GET`. Per RFC 9110 the Allow header must list
every supported method; `writeSecurityTxt` gets this right (`Allow: GET, HEAD`).

Minimal repro (live server):
```
curl -I -H "Authorization: Bearer <identity-secret>" http://127.0.0.1:42177/api/updates
# -> 200
curl -s -D - -X POST http://127.0.0.1:42177/api/updates | grep -i '^allow:'
# -> Allow: GET   (should be: Allow: GET, HEAD)
```
Fail-first test: `worker-1/updates-allow-header.test.mjs`
(`node --test worker-1/updates-allow-header.test.mjs`) — currently FAILS with
"Allow must include HEAD since HEAD /api/updates returns 200 (got GET)".
Suggested fix (not applied; worker has no commit rights on this lane):
`server/http.mjs:3181` `{ Allow: "GET" }` → `{ Allow: "GET, HEAD" }`.
Note: `/api/needs-me` (line ~3145) has the same GET-only Allow while accepting
HEAD — outside this shard, flagging for whoever owns it.

## Characterized non-findings

- `?kinds=` + 100k chars → ECONNRESET: Node's default `maxHeaderSize` (16KB)
  kills the socket before the app sees it (16,384–20,000 chars → proper 431;
  ≤15,000 chars → app 422). Transport-level Node default, not an app bug.
- Chunked/framed-body GET anomalies during early probing were test-client
  artifacts (unframed body bytes on a keep-alive connection → server 400/RST,
  standard Node behavior); with explicit Content-Length all GET-with-body
  cases return the route's normal status.

## Otherwise verified correct

- security.txt: 404 w/o `ROOM_SECURITY_CONTACT`, 200 text/plain + `Expires`
  with it (all 3 path aliases + trailing slash); 405 + `Allow: GET, HEAD`.
- github/link/start: 401 anonymous (auth-before-config, no oracle), 405 on all
  non-GET methods.
- /api/updates: 401 anonymous, 405 wrong methods, 422 on every malformed query
  (`limit` NaN/negative/0/fractional/>100/Infinity/empty/duplicate, unknown
  param, bad `state`, bad `kinds`, junk cursor, wrong-shape cursor), 200 on
  valid authed reads (GET + HEAD), server alive after the full battery.
- No crashes, no hangs, no 5xx in 71 cases + probes.

## Files

- `worker-1/fuzz.mjs` — request battery (env `FUZZ_PORT`, `W1_SECRET`)
- `worker-1/probe.mjs` — follow-up threshold probes (query length, GET bodies)
- `worker-1/fuzz-results.json` — full case results
- `worker-1/updates-allow-header.test.mjs` — fail-first test (red)
- `worker-1/REPORT.md` — this file
- `worker-1/server.log`, `server2.log`, `server3.log` — local server logs

Infra note: my first two local servers were reaped mid-task (processes vanished;
worker-4's and worker-18's servers also died). Fuzzing completed against a
re-launched detached instance (`setsid`) on 42177/42178. /dev/null is healthy.
