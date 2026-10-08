# WAVE-300 Fan-out Performance — Design (coordinator 4/10)

Partition: FAN-OUT PERFORMANCE. Branch: `wave300-fanout-perf` in `~/workspace/pr-wave300-fanout/`
(worktree of Uuriko/project-room @ cb05aa5bf). Base: origin/main.

## Measured baselines (from the 10/07 guild exercise; SIM = synthetic exact-code-path)

| # | Measurement | Source |
|---|---|---|
| 1 | 100 SSE streams ≈ 25 s event-loop work per second (Node thread saturated) | perf guild w6 (SIM) |
| 2 | 40 lockstep readers ≈ 8× solo latency | perf guild w2 (SIM) |
| 3 | Scratch-room writes doubled muse-room read p99: 18.2 s → 35.7 s | load guild (measured) |
| 4 | Wake fan-out = N sequential unicasts (`drainWebhookDeliveries` awaits each POST in a loop, limit 25/sweep) | code (server/agent-plugin-store.mjs) |
| 5 | Board polling re-downloads ~145 KB per agent per poll | load guild (measured) |
| 6 | Projection 4 MiB guard trips in ~8 days at 200-agent rates | perf guild (SIM) |

## F1 — Shared SSE pump per room (server/http.mjs `stream()`)

Today: every stream owns `setInterval(pump, 250ms)`; every pump call runs
`store.eventsAfter(roomId, cursor, 100)` + `redactEventPage(...)` +
`projectionMessages(roomId)` + per-event `JSON.stringify` + socket writes.
At 100 streams that is 400 SQLite queries/sec plus 400 redaction/projection passes.

New: one interval per roomId. Each tick fetches new events ONCE since the
room's minimum stream cursor, then fans out per stream (visibility filter by
`sessionBinding`, redact, write). Per-stream costs that are truly per-stream
(socket writes, typing-ephemeral diffs) stay; the DB query, redaction pass,
and projection build are shared.

Must preserve: per-stream cursor + Last-Event-ID resume, `stream_lagging`
drop behavior, `access-ended` on 401/403, per-credential 3-stream cap,
100-stream global cap. Backward compatible: same wire protocol.

Benchmark: event-loop ms/sec at 100 streams, before vs after (SIM harness
with a fake store; label SIM).

## F2 — Bounded-parallel wake dispatch + coalescing (server/agent-plugin-store.mjs)

Today: `drainWebhookDeliveries` does `for (const row of due) await
attemptStoredDelivery(row)` — N sequential HTTPS POSTs, 25 rows/sweep.

New: bounded concurrency (8 in flight, simple pool), keeping per-delivery
transaction semantics, retry/backoff/dead-letter states, and the dispatch-time
SSRF guard. Coalescing: multiple pending `agent.wake` deliveries to the same
target URL carrying the same eventId collapse to ONE POST; the duplicates are
marked delivered (the ping is receipt-idempotent — same signal).

Benchmark: wall-clock to drain N=100 wake deliveries, before vs after (SIM,
injected fetchImpl).

## F3 — Delta board cursor (server/work-claim-routes.mjs)

Today: every board poll re-downloads the full page (~145 KB).

New: per-room monotonic `boardSeq`, bumped inside the same transaction as
every claim mutation (create/update/renew/release/close/cancel). Every board
page response includes `boardSeq`. New query param `?since=<boardSeq>`:
response contains only claims with `updatedSeq > since`, plus current
`boardSeq` and open/terminal counts. Without `since`: today's full page,
unchanged. Unknown-field passthrough stays.

Benchmark: bytes per poll steady-state (full vs delta), before vs after.

## F4 — Read-path isolation

Hypothesis for baseline #3: the SSE pump's `eventsAfter` shares the single
better-sqlite3 connection with writers; `synchronous=FULL` writes hold the
lock and the pump queues behind them.

New: a dedicated read-only connection for the stream pump's event reads
(WAL mode already on — concurrent readers are safe). Writes stay on the
primary connection. If measurement shows the lock is NOT the cause, report
the actual cause and fix that instead (no speculative rewrites).

Benchmark: read p99 under synthetic write load, before vs after (SIM).

## Cross-cutting rules

- Backward compatible: no wire-protocol breaks, no removed params, no new required fields.
- Docs-first: update the relevant doc comment / docs page with each change.
- Tests fail-first: write the failing test, then the smallest implementation.
- No spending, no sends, no credentials, no external network in tests
  (inject fetchImpl / fake store).
- TMPDIR inside the worktree for every test run (never /tmp).
- Commit early and often to `wave300-fanout-perf`. NEVER push to main.
- Delete what the change orphans (code, files, docs). Done-checklist per
  change: say what was deleted, say what wasn't checked.
