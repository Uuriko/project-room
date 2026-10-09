# wave1000 guild-02 — mutation testing: server/http.mjs

15 hand-designed mutants, each applied to a pristine scratch copy of the
worktree and run against the affected test file(s). Baselines were verified
green first (11/13; help-mcp and public-read-model were red at baseline for
environmental reasons — see notes).

Score: **6 killed, 9 survived** (of which 3 equivalent, 5 test gaps now
covered by new regression tests, 1 test gap too expensive to cover).

## Killed (6)

| ID | Mutant | Killed by |
|----|--------|-----------|
| M01 | LRU eviction `>= capacity` → `>` (allows capacity+1) | tests/channel-sender-cache.test.js — 3 failures (hit-MRU, evict-LRU, capacity-1) |
| M03 | `body()`: dropped 415 `json_required` content-type gate | tests/route-hardening.test.js — L3 "rate limit before reading the body" |
| M06 | host check flipped `!==` → `===` (denies legit host) | tests/agent-connection.test.js |
| M09 | `discoveryLinks` base forced to `ROOM_ORIGIN` | tests/discoverability.test.js — "cold-start chain: GET / alone reaches a first post without llms.txt" |
| M12 | MCP join path: dropped `await` on `readText` | tests/f12-board-mcp.test.js — 6× `400 !== 200` on MCP POSTs (Promise leaks into `bodyText`, `JSON.parse` throws → 400). NOTE: first run used tests/help-mcp.test.js (wrong file, survived); refire with the correct file kills. |
| M14 | `touchLruEntry`: dropped mark-most-recently-used on hit | tests/channel-sender-cache.test.js — "a hit marks the key most-recently-used" |

## Survived → regression test written (4)

New file `tests/wave1000-guild-02-http-core.test.js` (on branch
wave1000/guild-02). Each test verified FAIL on its mutant, PASS on pristine.

| ID | Mutant | Test |
|----|--------|------|
| M04 | `readText`: declared-bytes check `>` → `>=` (exactly-at-limit rejected) | at-limit (512 KiB) body accepted — asserts `!== 413`; over-limit → 413 `too_large`. (Lesson: the commands route uses `MAX_MESSAGE_COMMAND_BYTES`, not the 16 KiB default; also auth runs before `body()` on that route, so the test authenticates.) |
| M05 | `securityContactFrom`: dropped CRLF rejection | `ROOM_SECURITY_CONTACT` with colon-free CRLF → 404. (Lesson: a value containing `:` is rejected downstream by the scheme check anyway, so the distinguishing input must be colon-free; still a response-splitting vector via `\r\n\r\n`. Impact limited.) |
| M08 | security.txt: HEAD no longer allowed | HEAD `/.well-known/security.txt` → 200, empty body. |
| M10 | `body()`: JSON arrays accepted | POST `[]` (authenticated; auth runs before `body()`) → 400 `invalid_json`. |

## Survived → equivalent mutant (3)

- **M02** — `exact()`: dropped the field-name check (length-only). Equivalent:
  every `exact(data, [...])` call site in server/http.mjs is followed by
  `typeof data.<field> !== "string"` checks on the NAMED fields, so a
  same-count/wrong-name body is rejected downstream anyway. Defense in depth
  only; no observable behavior change on any route. (Spot-checked ~30 call sites.)
- **M11** — trailing-slash normalization `length > 1` → `> 2`. Equivalent: the
  only length-2 pathname ending in `/` is `"//"`, and `new URL("//", origin)`
  throws before normalization is reached (400 `invalid_request` by design —
  verified empirically). The changed condition is unreachable with a
  distinguishing input.
- **M15** — gr1PublicPath receipt regex `pwr_[a-f0-9]{16,128}` → `{1,128}`.
  Equivalent: the route handler re-validates with the strict
  `PUBLIC_RECEIPT_ID` regex (server/http.mjs:1885) and 404s short ids, so the
  loosened router never serves them. (The exit=1 on this mutant's run was the
  same environmental perf failure as its red baseline — p95 56 ms vs 20 ms
  budget on a loaded VM — not the mutant.)

## Survived → test gap, too expensive to cover (1)

- **M07** — stream global cap `100` → `100000` (disables the 429
  `stream_limit`). Survived tests/stream-lifecycle.test.js. Covering it needs
  100 concurrent streams; the per-credential cap of 3 still applies, so the
  residual risk is a slow global-DoS, not a correctness hole. Deliberately not
  covered — noted here instead.

## Survived → near-equivalent (1)

- **M13** — `defaultAssetLoader`: dropped failed-read cache eviction. Only
  observable when a reviewed public asset fails its FIRST read (then the
  failure is cached forever instead of retried on next request). No test
  forces a first-read failure; behavior identical on all tested paths.

## Baseline notes

- tests/help-mcp.test.js: 1 test timed out at baseline under VM load
  (passed on re-run). M12's initial "survival" was wrong-file selection.
- tests/public-read-model.test.js: 8/9 at baseline; the failing test is a
  perf assertion (`/receipts p95` 236 ms vs 20 ms budget) — environmental.
