# wave1000 guild-02 — HTTP fuzz: server/http.mjs

Raw-socket fuzzer (`scratch-guild-02/tools/fuzz-http.mjs`, kept out of the
repo) boots `createRoomServer` on 127.0.0.1:0 with a real `RoomStore` and
fires hostile inputs per class. Assertions per input: response within 10 s
(no hang), **no 500**, connection left in a clean state (pipelining /
smuggling checks).

Result: **13/15 classes PASS, zero 500s across all inputs.** No request
smuggling. F07 (slowloris) FAILS — headline finding below.

## Per-class results

| ID | Class | Result | Observed |
|----|-------|--------|----------|
| F01 | malformed methods (empty, `GE T`, unknown, lowercase, NUL, 500-char) | PASS | 400s / closed-no-response; no 500 |
| F02 | malformed paths (bad `%`, `//`, traversals, NUL, control char, 10 KB path, query bomb) | PASS | 400/404; `//` → 400 `invalid_request` (by design, see M11) |
| F03 | oversized headers (20 KB single, 200 headers, no-colon, NUL value) | PASS | 431 / connection close; no 500 |
| F04 | oversized bodies (100 KB, declared-huge-sent-little, exactly-at-cap, one-over) | PASS | 413 / 401; declared-huge-sent-little times out client-side, server unaffected |
| F05 | wrong content-types (text/plain, none, json+charset, json-evil) | PASS | 415 `json_required` or 401 (auth runs first on that route) |
| F06 | invalid JSON (truncated, garbage, `[]`, `null`, empty, dup keys) | PASS | 400/401; `[]` → 401 unauthenticated (auth before body), 400 `invalid_json` with auth |
| F07 | slowloris drip (1 header line / 100 ms × 40) | **FAIL** | see headline finding below |
| F08 | 100 concurrent GET /api/health | PASS | all 200, no hang |
| F09 | chunked stall (2 chunks then 8 s stall; invalid chunk size) | PASS | 401 / 400; server stays responsive |
| F10 | HTTP/1.0 no-Host, HTTP/0.9 style | PASS | 403 / 200 / 400 |
| F11 | absolute-form target, wrong-host absolute URI, CONNECT, OPTIONS * | PASS | 200 / 200 / 404 |
| F12 | CL+TE both present; pipelined short-CL POST + GET | PASS | 400 on the ambiguous message; pipelined GET answered independently — no smuggling |
| F13 | method misuse on liveness paths | PASS | POST→405+Allow, DELETE→405, HEAD→200, TRACE→405 |
| F14 | host mismatch (wrong host, bad port, double Host, userinfo) | PASS | 403 ×3, 200 on duplicate-Host (Node keeps first) |
| F15 | pipelining integrity (3 pipelined GETs; exact-CL POST + GET) | PASS | [200,200,404] and [401,200] — second response always matches the second request |

## Headline finding: slowloris connections are NOT bounded (F07 FAIL)

`server/http.mjs:5005-5007` sets `server.requestTimeout = 15000`,
`server.headersTimeout = 10000`, `server.keepAliveTimeout = 5000` — the
clear intent is to bound slow-client connection holds. **Empirically, none
of these reap an idle or slow-dripping connection** in this environment
(Node v24.20.0):

- Drip probe (1 header line / 100 ms, never terminating): server-side socket
  still open at **30 s** — no close, no 408.
- Fully idle probe (zero bytes sent): still open at **25 s**.
- Bare `node:http` server with identical settings (properties AND
  constructor-options forms): identical non-enforcement; neither the socket
  `'timeout'` nor the server `'timeout'` event fires.

So this is **platform behavior, not an http.mjs defect** — the module sets
the knobs correctly — but the defense-in-depth intent is not realized: a
slowloris can hold connections indefinitely (bounded only by fds/memory),
and the 15 s bound the code appears to promise does not hold. An
application-level idle watchdog (e.g. destroy sockets with no complete
request line within N s) would be needed for a real bound. Production runs
behind Cloudflare, which enforces its own edge timeouts; the exposure is at
the origin.

## Bugs found by fuzz

1. **Slowloris unbounded hold** (above) — robustness gap, platform behavior,
   needs an app-level watchdog for a real bound.
2. Otherwise: no 500 on any input; no hangs beyond the (unenforced)
   timeouts; no smuggling; no crash.
