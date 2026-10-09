# WAVE-500 W8 — Slow-consumer backpressure for streams

Worker W8, coordinator 5/6 (swarm-scale presence + streaming). Mission: a slow
stream consumer must NEVER stall the room or its peers.

## Context and consistency

- The WAVE-300 honest-backpressure lane (`wave300/honest-backpressure`) replaced
  silent queueing with truthful load shedding: 429 means *you* are over your
  quota (with `Retry-After`), 503 `shed_load` means the *server* is shedding
  (with `Retry-After`). Every refusal is fast and says why. This work wires the
  same semantics into stream admission instead of inventing a parallel scheme.
- The WAVE-300 F1 shared pump (`wave300-fanout-perf`,
  `docs/WAVE300-FANOUT-DESIGN.md`) replaces per-stream `setInterval` pumps with
  one interval per room. It introduces a NEW stall risk: one far-behind/slow
  stream can hold the room's shared window. F1 is **not** in this branch's base;
  the guard below is implemented against the current per-stream pump and
  written to compose with the shared pump (§5).

## 1. Audit: the per-stream write path

`stream()` in `server/http.mjs` (before this change):

- One `setInterval(pump, streamInterval)` per stream (default 250 ms). Each tick
  runs `store.eventsAfter` + `redactEventPage` + `projectionMessages` + per-event
  `JSON.stringify` + socket writes.
- Socket writes are `res.write()` — **never blocking, never awaited**. A slow
  TCP peer cannot stall the event loop or a peer's pump through the write path.
  There is no application-level pending queue; the bound is the transport
  buffer, checked as `res.writableLength > streamQueueCap` (default 64 KiB,
  a `createRoomServer` option).
- When the bound trips mid-batch the pump stops feeding that stream for the
  rest of the tick; after the tick the stream gets one final
  `event: stream_lagging`, the stream is ended alone, and the socket is
  destroyed if it never drains within 5 s (`STREAM_DRAIN_GRACE_MS`). Peers keep
  their own buffers. Reconnect with `Last-Event-ID` resumes from the last event
  the client actually processed. Wire protocol unchanged.

Two characteristics worth knowing (both pre-existing, both preserved):

- **Burst semantics.** The check runs synchronously after each write, before the
  event loop can flush to the kernel. A single tick's burst over the cap trips
  the guard even for a client that is draining as fast as it can. Size the cap
  above the room's max per-tick burst per stream (measured: ~100 KiB for
  40 × 2.5 KiB events in one tick; the tests use 256 KiB).
- **Kernel absorption.** On loopback the kernel's TCP buffers absorb on the
  order of a megabyte before the server-side queue starts growing, so a stalled
  consumer needs a multi-MB flood to trip the guard in a test (the existing
  `stream-backpressure` test already works this way).

## 2. What was built

`createStreamWriteQueue(target, capBytes)` (`server/http.mjs`, exported for
unit tests): the per-stream bounded write queue as a first-class object.

- `write(chunk)` — fire-and-forget socket write; returns `false` when the write
  pushed pending bytes over the cap (or the socket is gone). The caller stops
  feeding the stream and runs the lag close path. The pump NEVER awaits a write.
- `lagging()` / `pendingBytes()` — `res.writableLength` against the cap
  (trip is strictly greater, matching the previous semantics).
- The pump routes every byte through the queue (room events, the `: connected`
  heartbeat, typing ephemerals). On `!flowing` it calls the existing `lag()`
  path: diagnostic record, `stream_lagging` event, close alone, 5 s destroy
  grace. The queue handle is stored on the stream's `streams`-set entry
  (`entry.queue`) so the shared pump can find it per stream.

Stream admission now follows the honest-backpressure refusal split:

- Per-credential 3-stream cap → **429 `stream_limit`** ("close one of your own
  streams"). The route catch-all already adds `Retry-After: 60`.
- Global 100-stream pool cap → **503 `shed_load`** ("the server is shedding
  load; retry after the Retry-After delay", `Retry-After: 5`). The per-client
  check runs first: if you are over your own quota that is the actionable,
  truthful signal.

`docs/openapi.yaml` and `docs/SERVICE.md` document the split. Existing tests
updated (`tests/load-test-10x.test.js` asserts 503/`shed_load` + `Retry-After`
past the pool, 429/`stream_limit` + `Retry-After` past the credential cap).

## 3. Measurements

All on this VM (loopback), `node --test` harnesses under `tests/` and scratch
scripts in `.tmp/scratch/` (not committed).

**Per-tick cost (the F1 motivation, confirmed).** One pump tick across 100
streams at the log head (empty pages): **~10 ms per stream** — ~1 s of
event-loop work per 250 ms tick, i.e. **4× oversubscribed with zero slow
consumers**. `store.eventsAfter` dominates (10 ms at head; `authenticate`
0.2 ms, `flipExpiredMentions` 0.01 ms — the remainder is the read transaction's
sub-queries). A slow consumer does not cause this; the per-stream pump design
does. Fixing the aggregate cost is F1's job; this guard's job is isolation.

**Slow consumer (1 msg/sec drain) + 99 eager peers, 100-stream pool.**
Slow client: paused socket, `socket.read(2048)` once per second — the kernel
buffer fills between reads, growing the server's per-stream queue. Production:
20 × ~2.5 KiB events per batch.

| mode | slow outcome | peer marker latency (297 deliveries) | server mem Δ |
|---|---|---|---|
| guard ON (256 KiB cap) | `stream_lagging` diagnostic, dropped alone, slot freed | min 217 ms, p50 999 ms, p99 2537 ms, max 2538 ms | +21 MiB |
| guard OFF (1 GiB cap) | never dropped; queue grows unboundedly | min 525 ms, p50 1038 ms, p99 1053 ms, max 1053 ms | +31 MiB and climbing |
| baseline (no slow consumer) | — | p50 2236 ms, max 3023 ms | — |

Reading: peers are **not** degraded by the slow consumer in either mode — each
stream owns its pump and socket writes never block, so peer latencies sit in
the same band with and without the slow stream (the band itself is set by the
aggregate pump cost above). The guard's value is (a) bounding the slow
stream's queued bytes at the cap instead of unbounded growth, and (b) dropping
it fast with a truthful `stream_lagging` signal so it can resume via
Last-Event-ID instead of wedging forever.

**Committed test** (`tests/stream-backpressure.test.js`,
"one slow consumer among 99 peers"): 1 slow + 99 eager peers on raw TCP
sockets (undici's per-origin connection cap would queue fetch-based peers),
flood until the cap trips, then asserts: exactly one `stream_lagging`
diagnostic record, no peer tripped, the dropped stream's slot reopens (200),
and all 99 peers receive 3 post-drop markers with max latency < 30 s. The
exact final `stream_lagging` bytes + clean `\r\n0\r\n\r\n` end are asserted by
the pre-existing single-stream test. Pump interval 2000 ms in this test: at
the measured 10 ms/tick, 100 streams at the 250 ms default would saturate the
loop independent of this work.

## 4. Backpressure handshake (for clients and the admission endpoint)

- `429 stream_limit` → close one of your own streams and retry (per-credential).
- `503 shed_load` → the 100-stream pool is full; honor `Retry-After` and retry.
  An undeclared prober hitting the pool meets the same 503 as a declared one —
  the probing-intent admission endpoint (`POST /api/admission/intent`) stays
  advisory; the pool cap is the enforcement.
- A dropped slow consumer reconnects with `Last-Event-ID` (or `?after=`); the
  server never fast-forwards a healthy stream's cursor.

## 5. Composition with the F1 shared pump

When the shared pump lands, its per-tick fan-out reuses `entry.queue` per
stream:

1. After the single shared fetch, for each stream: run the existing
   per-stream steps (authenticate → visibility filter → redact) unchanged.
2. Before writing each event, check `queue.lagging()`; write via
   `queue.write(chunk)`; when it returns `false`, **skip the stream for the
   rest of the tick** and run the same `lag()` close path (diagnostic +
   `stream_lagging` + close alone + 5 s destroy grace).
3. **Never `await` a socket write** in the fan-out loop — writes stay
   fire-and-forget, so one slow stream's socket can never hold the room's
   shared window. The `stream_lagging` drop remains the guard that bounds the
   "streams ahead of the shared window wait for a far-behind stream" case
   F1's design calls out.
4. Cursor rules are unchanged: advance only past fully queued batches; a
   lagging stream keeps its last-sent sequence so Last-Event-ID resume is
   exact.

No wire-protocol change in any of this: `room-event` / `typing` /
`stream_lagging` / `access-ended` / `unavailable` keep their shapes, and the
429/503 admission split above applies identically under the shared pump.
