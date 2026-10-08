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

### Refined design (worker W1, 2026-10-08)

The single fetch goes through the existing `store.eventsAfter(token, roomId,
after, limit, binding)` — once per room per tick — with a new additive
`{ includeInvisible: true }` option (6th arg; default off, all other callers
unchanged). The option skips only the per-viewer filter (DM follow-ups,
PRIV-2 history floor, peer-private events), so the shared page holds the
**union** of every stream's visible rows; `next` was already viewer-independent
(scan-based), and mention chips are computed once over the raw page. The
fetch rides the leading (minimum-cursor) stream's credential and stays capped
at 100 rows, so one far-behind stream can't blow the batch — every stream
keeps its 100/page semantics.

Fan-out, per stream, per tick:
1. `store.authenticate(token, roomId, sessionBinding)` — a revoked/rotated
   credential ends only that stream with `access-ended` (401/403/
   `session_binding_changed`), peers unaffected. Cheap indexed lookups only.
2. The viewer visibility filter (mirrors `eventsAfter`'s filter exactly:
   `dmEventVisibility` + `rowInHistory` + `peerEventVisible`, via the same
   imported helpers), narrowed further to `sequence > stream.cursor`.
3. `redactEventPage` runs ONCE on the shared page (redaction is
   viewer-independent — tombstones and edit-history stripping keyed off the
   room projection), then per-stream socket writes with per-event
   `JSON.stringify`, typing-ephemeral diffs, and per-stream `stream_lagging`
   detection.
4. Cursor advance: `cursor = max(cursor, page.next)` after the full visible
   batch is queued (never backwards for streams ahead of the shared window);
   a lagging stream keeps its last-sent sequence so Last-Event-ID resume is
   exact.

Open-time `eventsAfter` validation, the 100-stream global cap, the
per-credential 3-stream cap, and the wire protocol are untouched. The room's
interval is created on first stream and cleared when the last stream leaves;
dead sockets are pruned each tick so the pump self-cleans.

Known tradeoff: streams ahead of the shared window wait while a far-behind
stream catches up (100 rows/tick). Socket-lagged streams are already killed
by `stream_lagging` within ~5s, bounding that case; a client opening with a
very old `after`/`Last-Event-ID` on a huge log stalls its room's peers until
it catches up. Accepted for F1; revisit if measured room stalls appear.

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

Design (committed 2026-10-08, `wave300-fanout-perf`):

- `WEBHOOK_DRAIN_CONCURRENCY = 8` (exported from `server/agent-plugin-store.mjs`).
  `drainWebhookDeliveries` runs the batch through a tiny promise pool: at most
  8 `attemptStoredDelivery` calls in flight. better-sqlite3 is synchronous, so
  the only await point inside a worker is the network POST (`postDelivery`);
  every DB mutation stays inside a synchronous `this.mutate(...)` callback —
  per-delivery transaction semantics are unchanged (one poison row cannot roll
  back the rest), and concurrent workers cannot interleave a transaction.
- The due-row SELECT is unchanged (pending/failed, due, enabled-subscription
  filter, LIMIT). The summary shape is unchanged (`processed / delivered /
  retried / deadLettered / skipped`).
- Coalescing happens per batch, inside the drain only: rows with
  `event_type = 'agent.wake'`, a non-null `event_id`, and a resolvable
  effective target URL (`target_url ?? subscription.url`) group by
  `url + eventId`. The first row in due order is the leader; the rest are
  followers. Only the leader is POSTed — `postDelivery` still runs its
  dispatch-time SSRF re-validation per POST, unchanged.
  - Leader `delivered` → each follower is `markDelivered` with the leader's
    exact signature + envelope (the signal that actually went out), plus the
    same pure-module `recordAttempt` cache update; followers count as
    processed + delivered in the summary.
  - Leader anything else (retried / deadLettered) → followers stay pending,
    untouched, for a later sweep.
  - Never coalesced: different eventIds, different effective URLs, non-wake
    event types, or null eventIds (a null eventId cannot prove "same signal").
- Journal rows keep their shape: followers get the leader's envelope bytes in
  `payload_json` and `state = 'delivered'`; the deliveryId on each row stays
  its own.

Benchmark: wall-clock to drain N=100 wake deliveries, before vs after (SIM,
injected fetchImpl, 20 ms artificial latency).

Measured 2026-10-08 (implementor W2, `wave300-fanout-perf`):

| POST latency (SIM) | before (sequential) | after (8-wide pool) |
|---|---|---|
| 20 ms | 9725 ms | 5650 ms (1.7x) |
| 200 ms | 34415 ms | 5129 ms (6.7x) |

The network-bound portion parallelizes ~8x; the remaining floor is the
pre-existing per-delivery fsync (~40-50 ms, serialized through the single
better-sqlite3 connection) — deliberately untouched, since per-delivery
transaction semantics are the durability contract. Gains grow as real
receiver latency dominates, which is the production case.

## F3 — Delta board cursor (server/work-claim-routes.mjs,
server/work-claim-sqlite.mjs)

Today: every board poll re-downloads the full page (~145 KB).

New: per-room monotonic `boardSeq`, bumped inside the same transaction as
every claim mutation (create/update/renew/release/close/cancel/reassign —
plus delete and lease-expiry auto-release, which also change the visible
board). The counter lives where each registry lives:

- Durable registry (`server/work-claim-sqlite.mjs`): a `work_claim_board_seq`
  table `(room_id TEXT PRIMARY KEY, seq INTEGER NOT NULL)`, created lazily
  with `CREATE TABLE IF NOT EXISTS` on first bump/read — deliberately NOT
  added to `workClaimSchema`, so `verifySchema()`'s exact-shape check never
  fires on existing DBs (no reconciliation path, no schema version bump).
  `set()` bumps the room's row with an atomic
  `INSERT … ON CONFLICT DO UPDATE SET seq = seq + 1 RETURNING seq` and stamps
  the stored claim JSON with the new seq; `delete()` bumps too. Because the
  bump runs on the same db connection inside `set()`, it rides the caller's
  `registry.transaction(run)` — the same transaction as the claim write.
- In-memory registry (`createWorkClaimRegistry`, the pure-test fixture):
  a per-room seq map; `set()` bumps and stamps the same way. `delete()`
  does not exist there.

Each claim row records the `boardSeq` at which it was last mutated
(`boardSeq` is a known field of the persisted-row envelope, defaulting to 0
for rows written before this change — old claims read back as seq 0 and are
only ever re-sent when they actually change). The pure state machine
(`server/work-claims.mjs`) stays dependency-free: `workOf()` drops `boardSeq`
on re-normalization and every registry `set()` re-stamps the fresh seq, so
the stored value can never go stale. Write responses (create/claim/update/…)
are unchanged; only the board page carries the cursor.

Every board page response (`buildWorkClaimPage`) includes top-level
`boardSeq` (the room's current counter, passed in by the route from
`registry.boardSeq(roomId)`). New query param `?since=<boardSeq>`: response
contains only claims with `boardSeq > since` (sorted by `boardSeq` ascending —
mutation order), plus current `boardSeq` and room-wide `openClaims` /
`terminalClaims` counts. Delta responses carry each claim's `boardSeq` so the
delta is self-describing. Without `since`: today's full page, unchanged
except the added top-level `boardSeq` (per-claim `boardSeq` is stripped from
full pages so their claim shape is byte-for-byte identical). `since` is
accepted alongside `limit` and `view`
but the delta is never truncated by `limit` (a truncated delta with no cursor
would be unpageable); combining it with `cursor`, `queue`, or `state`
is 400 `invalid_input`, as is a non-`^\d+$` value. Unknown query params keep
their existing 422; unknown claim fields keep passing through.

Caveats: deletions advance `boardSeq` but ship no tombstones — a caching
client that sees the seq jump without matching deltas should re-fetch the
full page. Lease-expiry auto-releases on the read path bump the seq before
the page is built, so a sweep shows up in the next delta.

Benchmark: bytes per poll steady-state (full vs delta), before vs after
(200-claim board, 2 claims changed).

## F4 — Read-path isolation

Hypothesis for baseline #3: the SSE pump's `eventsAfter` shares the single
sqlite connection with writers; `synchronous=FULL` writes hold the lock and
the pump queues behind them.

**MEASURED VERDICT — hypothesis REFUTED** (SIM, `perf/f4-read-isolation-sim.mjs`,
2026-10-08, current single-connection store):

- Phase A readers-only: eventsAfter p50 6.31ms / p99 189.37ms, pump-timer
  lateness p99 593ms.
- Phase B readers + scratch-room writers: p50 7.27ms / p99 102.85ms, timer
  lateness p99 2958ms.
- Phase C readers + CPU-burn control (same event-loop wall time as B's
  writes, zero sqlite work): p50 10.76ms / p99 260.63ms, timer lateness p99
  2048ms. The no-DB control degrades like the DB writes — the mechanism is
  event-loop queueing of synchronous work, not sqlite lock contention.
- Probe D (cross-thread): a worker_threads writer holding `BEGIN IMMEDIATE`
  open with slow inserts for 1.5s on its own connection does NOT stall
  main-thread `eventsAfter` (p99 178ms during the hold) — in WAL mode readers
  never wait on the writer's RESERVED lock.
- Probe E: `store.room()` (what the pump's `projectionMessages()` decodes)
  p99 0.20ms warm vs 7.37ms when scratch-room writes drop the cache.

So a dedicated read connection in this single-threaded synchronous engine
cannot help: it removes no event-loop work, and WAL already lets reads
proceed past a held write lock. No speculative rewrite was built.

**Actual measured write→read coupling, fixed instead:** every outermost
write transaction (plus a `db.prepare`/`db.exec` monkey-patch watch)
cleared the WHOLE projection cache, so under scratch-room write load each
pump tick re-decoded the muse room's projection from scratch. The lookup
was already sequence-keyed, and every hot-path writer bumps
`rooms.sequence` with the projection (verified: all `UPDATE rooms SET
sequence=?,projection=?`; the only no-bump writers are the
`repairProjectionShape` / `replayProvenance` / `rehydrateAllProjections`
repair paths, which now invalidate their own room's entry via the new
`ProjectionCache.invalidate(roomId)` / `store._dropProjectionRoom(roomId)`).
The blanket clear, the `_armProjectionWatch` monkey-patch, and the orphaned
`ROOMS_WRITE` regex were deleted.

Benchmark: pump-tick read cost (`eventsAfter` + `store.room`) under
synthetic scratch-room write load, before vs after (SIM, `perf/f4-after-probe.mjs`;
"before" emulates the old blanket clear against the new code):
before p50 6.91ms / p99 88.59ms → after p50 4.34ms / p99 17.49ms.
The residual p99 is event-loop queueing behind the writer bursts themselves —
no read-side change can remove that; it is F1's shared-pump territory.

Tests: `tests/f4-projection-cache-isolation.test.js` — (1) other-room write
keeps a warm projection (failed before the fix), (2) same-room write still
invalidates (sequence bump), (3) pump reads complete during a write
transaction held open on another room (locks in the refutation).

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
