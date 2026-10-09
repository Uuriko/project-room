# Fuzz + load report (guild-12)

Harnesses: `findings/guild-12/bin/sse-fuzz.mjs` (F1–F6, F11–F15 — real
`createRoomServer` on 127.0.0.1), `findings/guild-12/bin/wake-fuzz.mjs`
(F7–F10 — in-process via the acceptance fixture). Launcher
`bin/run-fuzz.sh` enforces a hard timeout per unit; verdicts in
`fuzz-results.log`, raw logs in `logs/F*.log`.

## SSE fuzz

| Unit | Input | Result |
|---|---|---|
| F1 | slow consumer (never reads), 64KB queue cap | **PASS** — `stream_lagging` after ~40 events, socket destroyed ~7.7s, reading peer got 24 events uninterrupted |
| F2 | 200 rapid open/abort cycles | pending |
| F3 | valid Last-Event-ID resume | **PASS** — resumed from seq-2 got exactly the 2 newer events; tip resume clean |
| F4 | future Last-Event-ID (999999999) | **PASS** — `409 cursor_ahead`, no hang, server healthy |
| F5 | 12 garbage cursors (`abc`, `-1`, `1e21`, `0x10`, `NaN`, `Infinity`, `💥`, `../..`, 100KB digits, SQLi, `%00`, space) | **PASS** — all `4xx` (one `431` for the 100KB URL), zero `500`s, zero hangs |
| F6 | no-auth / bad-token / bad-room / POST-to-stream; header-vs-query precedence | **PASS** — all rejected; `Last-Event-ID` header wins over `?after=` |
| F11 | 300 concurrent streams (staggered, 10 rooms × 10 members) | **PASS** — exactly 100 accepted / 200 rejected `429`; event-loop lag max 8743ms p99 1695ms, cpu 2744ms over ~20s |
| F12 | 500-attempt thundering herd (2 rooms × 100 members, 60s timeout) | **PASS** — 100 accepted / 400 rejected, all 500 resolved (no hangs, no 500s); event-loop lag max 15.8s p99 1.5s, cpu 6.3s over ~37s. Server survives but gets extremely sluggish. |
| F13 | broadcast storm: 100 streams × 300 events | pending |
| F14 | 1 stalled + 5 reading | pending |
| F15 | chaos: everything interleaved | pending |

## Wake-queue fuzz

| Unit | Input | Result |
|---|---|---|
| F7 | 18 hostile enqueue payloads | **PASS** — all rejected cleanly; idempotency intact. **2 known gaps tracked** (see below) |
| F8 | 400-enqueue flood + receipt-cap fill | **PASS** — exactly 200 accepted / 200 refused at the active cap; receipt cap enforced; `integrity_check` ok |
| F9 | 50× lease race + complete idempotency | **PASS** — exactly 1 lease winner; wrong-owner complete → 409; retry → duplicate no-op; cross-wake requestId collision → 409 |
| F10 | 300 pause/resume cycles + enqueues | **PASS** — `due()` empty on every paused check; 15 wakes due at end |

## Findings (with repro)

**FINDING 1 (low): `enqueue()` accepts negative `dueAt`.**
`server/wake-queue.mjs` validates `dueAt` as a safe integer and rejects
`dueAt > now + horizon`, but sets no lower bound. A wake "due in 1969" is
recorded and immediately due.
Repro: `wakeQueue.enqueue(key, room, { requestId, queueKey: "neg",
intent: {x:1}, dueAt: -5, maxAttempts: 3 })` → succeeds (should 422).
Fail-first regression: `findings/guild-12/regress/enqueue-negative-dueat.test.js`
(FAILS on current code — the bug is live, not just a gap).

**FINDING 2 (low): `intentBytes` counts UTF-16 code units, not bytes.**
`intentJson.length > wakeQueueLimits.intentBytes` — `"💥".repeat(2000)` is
4000 code units (< 4096) but 8000 UTF-8 bytes. The "byte" cap can be
exceeded ~2x with astral-plane characters. No corruption (SQLite TEXT),
just a limit-name/enforcement mismatch.

**FINDING 3 (medium, load): per-stream pump saturates the event loop at
~100 held streams.**
`eventsAfter` costs ~2.6ms at 1 member, scaling ~O(members) to ~24ms at
100 members (measured). The pre-F1 `stream()` runs one pump per stream per
tick: 100 streams × 25ms = 2.5s of synchronous work per 250ms tick — the
event loop is 10x oversubscribed, new connection accepts starve (249/300
opens timed out at 20s in the herd test), and event-loop lag hit 8.7s max
even in the staggered 10-member-room case. The server does not crash, 500,
or stall existing streams — it degrades by getting slow. The wave300 F1
shared pump (1 fetch/room/tick; bench: 1396 → 27 calls, ~52x) directly
addresses the pump side; the ~O(members) `eventsAfter` cost remains for the
open path. Repro: `tests-bench-tmp/g12-dbg4.mjs` (100 concurrent opens,
p50 4.8s with pump idle).

Neither finding is a BUG CONFIRMED room post (guild rule: exactly two room
messages; findings 1–2 are low severity and tracked here with fail-first
tests / repros; finding 3 is covered by the wave300 F1 work).

## Harness bugs fixed along the way

- F5's status allow-list missed `431` (100KB URL) — widened to include
  `414`/`431`; both are clean rejections.
- F1/F14's lagging detection used a broken pause/resume dance on the raw
  socket — replaced with in-process `console.warn` interception (the server
  logs the `stream_lagging` diagnostic) + end-of-stream drain.
- F8's 5000 individual receipt inserts fsync'd for minutes — wrapped in one
  `store.transaction`.
- F10's 300 distinct storm keys tripped the 200-active cap — cycles 10 keys.
