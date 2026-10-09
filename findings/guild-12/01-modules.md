# Guild-12 slice: streams — module map

Static slice (glob `server/*stream*.mjs`, `server/*sse*.mjs`, `server/*wake*.mjs`):

| File | Lines | Role |
|---|---|---|
| `server/wake-queue.mjs` | 353 | Durable per-member wake queue: coalescing enqueue, leases, bounded retry with backoff, dead-lettering, member pause/resume, crash recovery. Draft-class surface. |
| `server/work-wakes.mjs` | 113 | Pointer-only work delivery on the heartbeat pull path: records work-item transitions as wake signals, serves them to opted-in hosts, ack marks delivered. |
| `server/wake-queue-limits.mjs` | 9 | Leaf constants module: all capacity/timing limits. Imported by `wake-queue.mjs` and light consumers without pulling in `store.mjs`. |
| `server/action-classes.mjs` | 86 | Observe/draft/act classification over every command type and out-of-band surface (`wake-queue` is `draft`). Fail-closed `classifyCommand`/`surfaceClass`. |

Closely-coupled code **outside** the slice (read-only for this guild; owned by other guilds):

- `server/http.mjs` `stream()` (~line 840–916) — the SSE endpoint itself: connection limits (100 total, 3/credential), per-connection send queue, `stream_lagging` drop, Last-Event-ID resume, typing indicators, abort handling. Fuzz/load targets in this guild exercise it black-box; no edits.
- `server/store.mjs` — hosts `wakeQueue`/`workWakes` instances, runs `recover()` at open, calls `workWakes.transition()` inside the command transaction.
- `server/agent-heartbeats.mjs`, `server/agent-plugin-routes.mjs`, `server/mcp-hosted-tools.mjs`, `server/mcp-room-profile.mjs` — consumers of `WorkWakes.pending/ack`.
- `server/human-push.mjs`, `server/web-push.mjs`, `server/push-subscriptions.mjs`, `server/notify-*.mjs` — push/notification paths; out of slice.

Test files covering the slice:

- `tests/wake-queue.test.js` — enqueue/coalesce/idempotency, lease/retry/backoff/dead-letter, restart recovery, receipt caps, guest denial, pause.
- `tests/agent-wake.test.js`, `tests/agent-wake-poll.test.js`, `tests/board-wake.test.js`, `tests/board-wake-ready-work.test.js`, `tests/room-mcp-wake.test.js`, `tests/pull-only-heartbeat-wakes.test.js`, `tests/agent-heartbeats.test.js` — WorkWakes transition/pending/ack/permitted behavior (client + store level).
- `tests/action-classes.test.js` — classification completeness + fail-closed.
- `tests/stream-lifecycle.test.js`, `tests/stream-backpressure.test.js`, `tests/stream-recovery.test.js`, `tests/stream-interval.test.js`, `tests/stream-shared-pump.test.js` (fanout branch), `tests/sse-sequenceof.test.js`, `tests/client-stream.test.js`, `tests/private-history-stream.test.js` — SSE endpoint behavior (in `http.mjs`).

Findings layout (`findings/guild-12/`):

- `bin/` — mutation driver, fuzz harnesses, launchers (runnable).
- `regress/` — fail-first regression tests.
- `logs/` — raw per-unit logs.
- `mutant-results.log`, `fuzz-results.log` — machine verdicts.
- `10-mutants.md`, `11-fuzz-load-report.md`, `12-reverify-report.md` — track reports.
- `00-index.md` (this file's sibling), `01-modules.md`, `02-stream-lifecycle.md`, `03-resume-semantics.md`, `04-drop-policies.md`, `05-wake-delivery.md`, `06-work-wakes-delivery.md`, `07-action-classes.md`, `08-gotchas.md`, `09-dead-code.md`.
