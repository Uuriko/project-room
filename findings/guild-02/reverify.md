# wave1000 guild-02 — re-verify: wave branches touching server/http.mjs

35 wave branches touch the slice; the 10 with the largest http.mjs diffs
were re-verified. Method per branch: scratch copy of current origin/main +
the branch's `server/http.mjs` + the branch's new `server/*.mjs` files;
boot smoke, the branch's own new http tests, and a battery
(channel-sender-cache, security-headers, legal-pages, route-hardening).
All branches are 194–454 commits behind main (bases 2026-10-08, tips
2026-10-09).

## Verdicts

| Branch | Result |
|--------|--------|
| wave300/honest-backpressure | **TESTS_FAIL** — route-hardening L1 breaks (see below) |
| wave300/payload-store | PASS (battery + own tests) |
| wave400/elegant-http-a | PASS |
| wave400/elegant-http-c | PASS |
| wave400/elegant-server | PASS |
| wave400/elegant-wcmisc | PASS |
| wave400/elegant-wcroutes-b | PASS |
| wave500/presence | **TESTS_FAIL** — branch's own TDD tests fail (see below) |
| wave500/presence-w2-pump | PASS (incl. its stream-shared-pump tests) |
| wave500/presence-w8-stream-bp | PASS |

## Breakage / findings

### 1. honest-backpressure: rate() semantic change breaks route-hardening L1
The branch changes `rate()` to check-before-increment ("a refused request
consumes no budget, extends no window, writes no durable state" — deliberate
per its comments). Existing test **L1 "thread reads share the per-credential
read rate limit"** fails against the branch's http.mjs (16.5 s, assertion).
The branch's own admission tests (admission-intent, command-admission,
honest-backpressure-rate — 17 tests) all pass. So the branch works as its
author intends but contradicts a main-suite contract: landing it requires
updating L1 or re-deciding the no-rearm semantics. Not a crash — a contract
conflict to resolve before merge.

### 2. honest-backpressure: acquisition page cache-control weakened (privacy)
`sendPage` lost its `cacheControl` parameter; the owner-only
public-receipts toggle page (`/r/<id>`) now sends `public, max-age=60`
instead of `no-store`. The removed comment warned explicitly: "must never
sit in a shared cache — a response cached while public would keep
disclosing a room's receipts after the owner switches privacy off." **This
re-opens a documented privacy hole.** Repro: GET the room page while
receipts are public, flip the toggle off, re-request → cached copy still
discloses.

### 3. `?messages=recent` snapshot windowing removed in 11 branches
honest-backpressure, presence, presence-w2-pump, payload-store, and all 8
elegant-* branches delete `SNAPSHOT_RECENT_MESSAGES` and the
`?messages=recent` code path (422 validation + `messagesWindow` metadata).
Main ships only the newest 100 visible messages on `?messages=recent`
(deliberate: muse-room's 5,300+ messages ≈ 5 MB per open). The branches
revert to full-history snapshot opens — a perf regression — and drop the
`messagesWindow` contract clients may rely on. Unrelated to any branch's
stated goal; likely stale-base revert or uncoordinated duplicate decision.
Needs an owner call before any of these merge.

### 4. `room_token_not_identity` honest-401 dropped in 4 branches
honest-backpressure, presence, presence-w2-pump, payload-store remove the
`link-agent-join` check that rejects API-key-shaped secrets with 401
`room_token_not_identity`. Effect is error-quality only (still 401, now
generic `unauthenticated`), not a bypass — but it weakens a deliberate
honest-error contract (Tab patch-02, 2026-10-05). The 8 elegant branches
keep it.

### 5. presence: branch's own FAIL-FIRST TDD tests fail (W6 unimplemented)
3 failures in the branch's own tests/presence-scale.test.js ("24h churn
leaves no ghost presence rows", "server-side presence delta subscription
exists", "authenticated non-heartbeat traffic refreshes presence liveness").
These are store-level (`AgentHeartbeats`) TDD tests written before the W6
implementation — they fail against the branch's own code by design, and are
outside the http.mjs slice (the http-level battery passes 13/13 and the
branch's stream-shared-pump tests pass 5/5). Noted so nobody reads the
TESTS_FAIL as an http.mjs regression.

### 6. elegant-*: 8 branches, 3 distinct http.mjs diffs (duplicated work)
elegant-http-a / elegant-server / elegant-wcmisc / elegant-wcroutes-b share
byte-identical http.mjs diffs; elegant-wcroutes-a / elegant-wclaims /
elegant-rooms-a share another; elegant-http-c is unique. The same change was
branched 4× and 3× — merge will conflict with itself. (All 5 tested elegant
branches PASS the battery.)

### 7. presence-w2-pump: shared-SSE-pump rewrite looks sound
The per-room shared pump (one 100-row fetch per room per tick, per-viewer
filter fan-out) keeps the stream cap 429, per-tick auth, cursor/lag
semantics, and typing ephemerals. Highest residual risk is the
`filterPageForViewer` mirror of `store.eventsAfter`'s visibility filter
(security-sensitive if the mirror drifts). Battery + its 5 pump tests pass.

### Staleness notes (not branch faults)
- honest-backpressure lacks the FO-DRIFT-1/2 auth-selector validation
  (f4d25b09a, 2026-10-08 17:57 UTC) — landed after its base; will arrive on
  rebase.

## Repro commands
Scratch dirs are disposable; the driver is
`scratch-guild-02/tools/reverify.py <branch>` (results in
`scratch-guild-02/results/reverify-*.json`). Diffs reviewed directly:
`git diff origin/main origin/<branch> -- server/http.mjs`.
