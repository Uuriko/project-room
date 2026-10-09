# SSE + Polling Survival Under Event-Budget Pressure (WAVE-500 W14)

Status: design + executable spec tests. **No changes to the live SSE path** —
per this worker's constraints, the degradation hooks in §2 are proposals for
the build lane. The test file (`tests/sse-budget-degradation.test.js`) pins
the decision logic that drives degradation (budget refusal semantics, cursor
rules, terminal-frame wire contract) without a live server.

## 1. How SSE cursors / reconnect work today (file:line ground truth)

### 1.1 Connection open

- `stream(req, res, token, roomId, after, auth, operationId)` —
  `server/http.mjs:849`.
- Open-time cursor validation: `store.eventsAfter(token, roomId, after, 100,
  binding)` (`server/http.mjs:851`) — throws 401/403 on lost access, so an
  unreadable cursor never opens a stream.
- Admission caps (`server/http.mjs:852`): **100 streams per server process**
  (the `streams` set, `server/http.mjs:635`), **3 per credentialHash** →
  429 `stream_limit` ("Close another room connection before opening more").
- Headers (`server/http.mjs:853`): `Content-Type: text/event-stream`,
  `Connection: keep-alive`, `X-Accel-Buffering: no`.
- `after` is the client's `Last-Event-ID` (the sequence of the last event it
  processed), passed as `?after=`.

### 1.2 The pump

- One `setInterval(pump, streamInterval)` **per connection**
  (`server/http.mjs:910`); `streamInterval` defaults to
  `STREAM_INTERVAL_DEFAULT_MS = 250` (`server/deployment.mjs:12`), range
  50–5000.
- Each tick: `store.eventsAfter(token, roomId, cursor, 100, binding)`
  (`server/http.mjs:879`) → `redactEventPage(..., projectionMessages(roomId))`
  → per event `id: <sequence>\nevent: room-event\ndata: <json>\n\n`
  (`server/http.mjs:880-888`).
- The cursor is the sequence of the last **written** event. Idle ticks write a
  `: connected transport only` comment heartbeat (`server/http.mjs:880`).
- Typing indicators ride as synthetic `event: typing` frames with **no `id:`**
  (`server/http.mjs:889-897`) — they never disturb Last-Event-ID resume.
- The resume contract is **lower-bound, not next-event**: reconnecting with
  `?after=N` returns every event with sequence > N. The client MUST NOT assume
  contiguity — ids can jump (§3). Every pump re-validates access through
  `eventsAfter`, so a revoked credential fails the stream on the next tick.

### 1.3 Slow-consumer isolation (today)

- `lagging()` = `res.writableLength > streamQueueCap`, default 65536 bytes
  (`server/http.mjs:301` parameter default, `server/http.mjs:867` predicate).
- On lag: one `event: stream_lagging` frame (no `id:`), a 5 s drain grace
  (`STREAM_DRAIN_GRACE_MS`, `server/http.mjs:263`), then `res.destroy()` —
  the socket is dropped; peers keep their own queues
  (`server/http.mjs:868-875`).
- Mid-batch: the pump stops writing at the lag point and the cursor stays at
  the last *sent* event; invisible rows are skipped only after a complete
  batch (`else cursor = batch.next`, `server/http.mjs:899-900`). A
  reconnecting client resumes from its last received event — nothing sent is
  skipped, nothing unsent is claimed.
- Terminal frames (`access-ended` on 401/403, `server/http.mjs:903`;
  `unavailable` on 503, `server/http.mjs:906`; `stream_lagging`) carry **no
  `id:`** — they never advance the resume cursor. §2's design follows this
  rule.
- Cleanup: `close`/`finish`/`error`/abort clears the interval and removes the
  entry (`server/http.mjs:860-866`). `server.closeStreams()`
  (`server/http.mjs:5006`) ends all streams (shutdown path).

### 1.4 What the fan-out lane changed (not in this tree)

- Branch `refs/heads/wave300-fanout-perf`, commit `d6e1daf72` ("F1: shared SSE
  pump per room"): one `setInterval` per roomId instead of one per stream.
  Each tick fetches new events ONCE since the room's minimum stream cursor
  (capped at the 100-row page), redacts once, builds the projection once,
  then fans out per stream: per-stream auth (401/403 → `access-ended`),
  viewer visibility filter, per-stream cursor advance, typing-ephemeral
  diffs, `stream_lagging` drop. Wire protocol unchanged; dead sockets pruned
  per tick; the room interval is torn down when the last stream leaves.
- Measured (SIM harness, 100 streams × 10 s @ 250 ms): `eventsAfter` calls
  1028 → 30; at-head pump burn 202.9 → 39.0 cpu ms/sec (~5.2×).
- Survival relevance: under F1 a slow consumer's cost is bounded by its own
  socket writes + typing diff — it can never hold the shared tick, because
  the shared fetch/redact happens once and lagging streams are dropped
  exactly as in §1.3. The 100-stream global cap and 3-per-credential cap are
  preserved. Any budget-pressure degradation (§2) must be implemented
  against the F1 shape too: the terminal decision is per-room, the terminal
  frame fans out per stream.

## 2. Honest degradation at 90% / 100% of event budget

Ground rule from W7 (`docs/wave500/EVENT-BUDGET-DESIGN.md`): **the budget
meters sequence consumption (writes); reads are unmetered.** A room at 100%
budget 409s writes (`pilot_limit`, `server/store.mjs:3436`/:4651) and 409s
unprivileged board writes below the 10% reserve (`room_event_budget_low`,
`server/work-claim-integrity.mjs:119-131`). It does NOT stop `eventsAfter` —
the pump keeps reading. So "degradation" here is not "stop serving reads";
it is **stop pretending the room is healthy.**

### 2.1 At 90% — WARN, no transport change

Streams keep flowing, unchanged. Budget pressure is delivered as *content*,
not transport: the owner-visible `room.budget_notice` system event (per
`docs/wave500/ROOM-ROTATION-DESIGN.md` §1) travels through the same
`room-event` frames every consumer already parses, with `% used`, events
remaining, and the rotation claim status.

No pump throttling, no stream drops, no special frames. Rationale: 90% is
the "rotation should exist" watermark; consumers need warning, not
interruption. Throttling reads at 90% would be a silent lie about room
health — the room is still fully readable.

### 2.2 At 100% — EXHAUSTED: terminal frame, then clean close

Two candidate shapes were considered:

| Shape | Pros | Cons |
|---|---|---|
| A. Terminal `room_budget_exhausted` event, then clean `res.end()` | Client gets a machine-readable reason *in the channel it already reads*; Last-Event-ID resume stays anchored; one mechanism shared with rotation's `room_rotated` | Requires the client to act on the terminal event |
| B. Refuse new connections with 429/503 + `Retry-After`, keep old streams | Standard HTTP refusal semantics | `Retry-After` on an *established* 200 stream is meaningless; reads are unmetered, so refusing them is dishonest; old streams would still need a signal |

**Recommendation: A.** When the room hits EXHAUSTED (no allocatable budget
left and no rotation in flight):

1. The pump (per-stream today; per-room under F1) sends a final frame with
   **no `id:` line**:
   ```
   event: room_budget_exhausted
   data: {"eventsRemaining":0,"successor_id":null,"hint":"Event budget exhausted; writes are refused. Reads and export remain available. Reconnect delay 60s.","reconnect_delay_ms":60000,"next":[{"command":"GET /api/rooms/{roomId}/export"}]}
   ```
   The body mirrors the `room_event_budget_low` refusal shape (`{
   error: { code, message }, eventsRemaining, hint, next }`,
   `server/work-claim-integrity.mjs:125-126`), and the no-`id:` rule follows
   §1.3 — the terminal event must never become a resume cursor.
2. The server then ends the stream **cleanly** (`res.end()`, not
   `res.destroy()`): a clean FIN is an honest "I'm done"; a destroy is
   indistinguishable from a network failure and invites an immediate
   reconnect storm.
3. The frame carries `reconnect_delay_ms` as a *hint*, not an HTTP
   `Retry-After` (which has no meaning on an open 200). The hint says the
   client SHOULD back off; the wire cannot enforce it.
4. A client that reconnects anyway gets: catch-up history up to head
   (bounded by the 100-row page cap), then the terminal frame again, then a
   clean close. Each reconnect costs the server at most one page + one
   frame — the reconnect loop is self-limiting because there is no new data
   to fetch.
5. If rotation completed, `successor_id` is filled and the frame is
   `room_rotated` instead (`docs/wave500/ROOM-ROTATION-DESIGN.md` §2 step 7)
   — budget-exhaustion and rotation share the terminal-frame mechanism; the
   budget frame is the case where no successor exists yet.

Why not close streams *before* exhaustion to "save budget"? Reads cost no
budget. Closing streams early would be the server lying to consumers about
room state to protect a meter they aren't consuming. The honest action is:
keep serving reads, tell the truth in-band, close cleanly only when the
room is truly done accepting new history.

### 2.3 New connection attempts at 100%

Still accepted — reads are unmetered, so refusing them would contradict §2's
ground rule. The first pump delivers catch-up history, then the terminal
frame + clean close. Exception: if the room is archived post-rotation, the
existing `room_archived` read path answers
(`docs/wave500/ROOM-ROTATION-DESIGN.md` §2 step 7): writes get 409
`room_archived` naming the successor; reads/streams on the archive work
normally.

### 2.4 What the terminal frame must never do

- Must not carry `id:` (would corrupt Last-Event-ID resume — §1.3).
- Must not be emitted more than once per stream (guard with a per-entry
  flag; under F1, per stream-entry).
- Must not be retried by the server: after the terminal frame, `res.end()`
  — the server does not keep the stream half-open "just in case."

## 3. Backlog on reconnect after compaction (W4 × W12)

### 3.1 Ground truth

- Compaction never renumbers: `room.sequence` is monotonic across
  compactions (`docs/wave500/COMPACTION-DESIGN.md` §3). Old cursors stay
  *valid* — they still order — but the history under them may contain gaps.
- Consumers are told about gaps via explicit discontinuity notices, not
  silent truncation (`docs/wave500/COMPACTION-DESIGN.md` §3.3). A cursor
  predating or sitting inside a compacted window still resolves; the
  caller's backlog scan starts from its cursor and the first thing it sees
  is the discontinuity notice, then the live tail.
- Backstop: cursors beyond `room.sequence` get 409 `cursor_ahead`
  (`docs/wave500/COMPACTION-DESIGN.md` §3) — distinct from "cursor inside a
  compacted window," which is legal.
- Server-held member cursors (`cursors` table, `server/store.mjs:1385`) are
  clamped past window ends at compaction time — no member's feed cursor is
  left dangling inside a gap (`docs/wave500/COMPACTION-DESIGN.md` §3.4).

### 3.2 What this means for the SSE stream

- **Reconnect is a lower-bound scan, not a replay.** `?after=<last-id>`
  returns events with sequence > after. If the window `(after, head]` was
  compacted, the consumer sees the discontinuity notice + live tail — never
  a fabrication of the compacted middle. The client MUST treat a jump in
  `id:` as normal (§1.2).
- **No rewind.** Cursor advance is advance-only: the cursor-semantics module
  (`server/read-cursor.mjs`) encodes this as `ackDurableCursor` = MAX
  (regress is a no-op) and `sessionWatermark` = max(durable, session). A
  reconnect presenting an *older* Last-Event-ID than the server's durable
  watermark resumes from the watermark, never from the older cursor — the
  server never replays history the consumer already acknowledged away.
- **No skip.** On migration/disagreement the fold is MIN (`foldHorizonsMin`,
  `server/read-cursor.mjs:39`) — when horizons disagree, the safe direction
  is backward (re-deliver), never forward (skip). Duplicate delivery is the
  consumer's problem to dedupe by `id:`; skipped delivery is
  unrecoverable. This is the same reason §1.3 keeps the cursor at the last
  *sent* event on lag: re-send beats loss.
- **Terminal frames stay out of the cursor.** Compaction does not move or
  renumber terminal frames because they carry no sequence —
  `room_rotated` / `room_budget_exhausted` / `stream_lagging` / `typing` are
  transport/ephemeral, never part of the compactable log.

### 3.3 Open seam (for the build lane)

The compaction design says consumers are "told" via discontinuity notices;
the exact event shape is not pinned. For SSE specifically: the notice
SHOULD be a normal `room-event` with the gap-start sequence as its `id:`,
so Last-Event-ID resume across the gap is well-defined. (Coordinate with
W4's implementing worker; W12's cursor module — `server/read-cursor.mjs` —
already provides the advance-only / MIN-fold primitives the resume path
needs.)

## 4. Per-consumer rate limits — one slow consumer can't hold the broadcast

### 4.1 What exists today (per-connection pump, this tree)

1. **Admission:** 100 streams per process, 3 per credential → 429
   `stream_limit` (`server/http.mjs:852`). The only *count* limit.
2. **Send-queue cap:** `streamQueueCap` (default 65536 bytes,
   `server/http.mjs:301`) on `res.writableLength` (`server/http.mjs:867`).
   Exceed → `stream_lagging` + 5 s grace → socket destroy. Per-connection,
   so one stalled socket's megabytes never grow the others' queues.
3. **Mid-batch break:** the pump writes per event and checks `lagging()`
   after each; it stops at the lag point and the cursor stays at the last
   sent event (§1.3). The pump never blocks on a slow socket — Node socket
   writes are non-blocking; the *queue* is the backpressure signal, not the
   write call.
4. **Keep-alive pruning:** `close`/`finish`/`error` + request-scoped abort
   all clear the interval and remove the entry (`server/http.mjs:860-866`);
   dead browser tabs in the Workers bridge are released via the platform
   signal.

### 4.2 What exists under F1 (shared pump, fan-out branch)

- The same per-stream `lagging()` predicate is applied per stream-entry
  during fan-out; a lagging stream is dropped exactly as in §4.1 while the
  shared tick continues for everyone else.
- The shared fetch is capped at the 100-row page since the room's *minimum*
  stream cursor — one far-behind stream cannot inflate the batch for the
  room.
- Per-tick dead-socket pruning; the room interval is torn down when the last
  stream leaves.
- Net effect: under F1 a slow consumer's worst case is its own drop. It
  cannot hold the broadcast because there is no per-consumer work on the
  shared path beyond non-blocking socket writes.

### 4.3 Recommended additions (build lane; no live-path changes here)

1. **Lag-drop accounting.** Count `stream_lagging` drops per room (counter,
   by room). A room whose lag-drop rate spikes under budget pressure is the
   early signal that its consumers can't keep up — cheaper than per-stream
   CPU attribution. Wire to the telemetry tripwires (W7's
   `event_budget_remaining_ratio` gauges).
2. **Do NOT add per-stream delivery-rate throttles.** A throttle ("max N
   events/sec per stream") would silently delay a consumer without telling
   it — the backpressure lane's law (`docs/wave500/EVENT-BUDGET-DESIGN.md`
   §3: no silent queuing) applies to reads too. The honest shapes are
   exactly two: deliver at pump speed, or drop with `stream_lagging` +
   reconnect guidance. There is no third shape.
3. **Keep the caps where they are.** 100/process and 3/credential are
   admission controls, not degradation controls; lowering them under
   pressure would punish the many for one stall. The per-connection queue
   cap is the isolation mechanism — it already bounds one consumer's damage
   to its own socket.
4. **Reconnect storms.** The 3-per-credential cap bounds one client; a
   *fleet* reconnecting at once (e.g. after a mass `stream_lagging` drop or
   a server restart) is bounded by the 100-stream global cap + 429
   `stream_limit` with its honest message. Under F1, 100 fresh streams cost
   one shared pump — the restart case is exactly what F1 was built for.

## 5. Cross-references

- Cursors/resume today: `server/http.mjs:849-910`; pump page size 100
  (`server/http.mjs:879`); idle heartbeat comment (`server/http.mjs:880`).
- Budget enforcement: `server/store.mjs:3436`/:4651 (409 `pilot_limit`);
  `server/work-claim-integrity.mjs:119-131` (409 `room_event_budget_low`);
  prototype allocator `server/event-budget.mjs` (W8).
- Budget design: `docs/wave500/EVENT-BUDGET-DESIGN.md` (W7). Rotation:
  `docs/wave500/ROOM-ROTATION-DESIGN.md` (W11). Compaction:
  `docs/wave500/COMPACTION-DESIGN.md` (W4). Cursor semantics:
  `server/read-cursor.mjs`.
- Fan-out (not in this tree): `refs/heads/wave300-fanout-perf`, `d6e1daf72`;
  design doc `docs/WAVE300-FANOUT-DESIGN.md` (on that branch).
- Existing stream tests (behavior this doc must not contradict):
  `tests/stream-backpressure.test.js`, `tests/stream-lifecycle.test.js`,
  `tests/stream-recovery.test.js`, `tests/sse-reconnect-chaos.test.js`,
  `tests/stream-interval.test.js`, `tests/sse-sequenceof.test.js`.

## 6. Not in scope for this worker

Per the task constraints: docs + one test file; **no changes to the live
SSE path**. The `room_budget_exhausted` terminal frame, lag-drop
accounting, and the compaction discontinuity-notice event shape are
proposals for the build lane. The test file
(`tests/sse-budget-degradation.test.js`) pins the *decision logic* that
drives degradation — the budget allocator's refusal semantics and the
cursor rules reconnect depends on — plus the terminal-frame wire contract,
all without a live server.
