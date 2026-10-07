# Load-test report — project-room — 2026-10-07

Task 167. Harness: `scripts/load-test.mjs` (commands/streams/queue/all
modes) + `tests/load-test-10x.test.js` (9 in-process scenarios) +
`tests/load-test-smoke.test.js`. All measurements on a shared dev VM —
absolute numbers are environment-specific; the ratios and breaking points
are the signal.

## Measured breaking points

| Probe | Result |
|---|---|
| Sequential plain POST `/api/rooms/commons/commands` | p50 ~104ms (direct `store.command`: ~41ms; HTTP adds ~60ms) |
| 16 concurrent writers × 25 posts | **6.5 posts/sec, p50 1744ms, p95 5425ms, p99 7605ms** — 17× p50 degradation vs sequential |
| Commands mode (10 agents, mixed work-session claims) | 8 ops/sec, p50 733ms, p95 2856ms |
| Stream pool | 100/server, 3/credential — over-cap is a clean 429 `stream_limit`, pool recovers on release (tested) |
| Chat flood guard | 30-post burst per (room, member), 0.5/s refill — overflow is 429, other members unaffected (tested) |
| Room size | 100 members max, 99 stream members |
| Wakes | 200 active per member; 1000-wake soak drains with zero loss (tested) |

**Headline:** write throughput saturates at ~6–8/s with sharply degrading
latency under concurrency. The bottleneck is the synchronous command path
(auth + validation + projection + sqlite writes block the event loop;
sqlite single-writer) — not the HTTP layer (≈60ms) and not the store
itself (≈41ms direct).

## The first 3 bottlenecks — fixed or filed

1. **FIXED — truncated NDJSON export replayed silently partial.** Found by
   the new chaos suite (`tests/chaos-scenarios.test.js`): dropping
   non-event rows from an export passed verification because the watermark
   checked only the event count. Fixed in `server/room-export.mjs`:
   watermark now carries per-table row counts, replay verifies them, and a
   failed replay removes the destination file it created. (Reliability fix
   discovered through load/chaos work.)
2. **FILED — concurrent write throughput collapse.**
   https://github.com/Uuriko/project-room/issues/1905 — 6.5/s at 16
   writers, p95 5.4s. Needs architectural work (async command pipeline
   and/or write batching); the numbers above are the baseline to beat.
3. **FILED — `room import round-trips a large (1500-event) export` hangs.**
   https://github.com/Uuriko/project-room/issues/1907 — pre-existing on
   pristine main; blocks the load-test file from running green end-to-end.

## What "10× peak" means here

No production peak metric was available to multiply. The measured ceiling
(~6–8 sustained writes/sec before latency collapses) is the number to plan
against: any peak above it needs the #1905 fix first. The guardrails (flood
guard, stream pool, rate limits) all degrade gracefully rather than
collapsing, which the 10x suite proves — the room fails *loud* (429s), never
silent, up to its saturation point.
