# SSE stream lifecycle (`server/http.mjs` `stream()`)

Route: `GET /api/rooms/:roomId/stream?after=<seq>` or `Last-Event-ID` header
(precedence: header > query param > 0). Auth: bearer room credential or session.

## Connect

1. `store.eventsAfter(token, roomId, after, 100, binding)` runs **before** headers —
   auth/cursor validation happens first. Invalid cursor → `422 invalid_cursor`
   (`after` not a safe non-negative integer); cursor ahead of room sequence →
   `409 cursor_ahead`. These surface as JSON errors, not SSE events.
2. Connection limits: `streams.size >= 100` (global) or ≥3 for the same
   `credentialHash` → `429 stream_limit` ("Close another room connection before
   opening more"). Checked synchronously per request, so the 100-cap is exact.
3. `200 text/event-stream`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
   The entry `{ credentialHash, sessionBinding, memberId, roomId, res }` joins
   the `streams` set. `timer = setInterval(pump, streamInterval)` (default
   from `STREAM_INTERVAL_DEFAULT_MS`; `timer.unref()`).

## Pump (every `streamInterval`)

1. If `res.destroyed || res.writableEnded` → cleanup, stop.
2. `batch = redactEventPage(store.eventsAfter(token, roomId, cursor, 100, binding), ...)`.
   Empty batch → `: connected transport only` comment (heartbeat).
3. Each event: `id: <sequence>\nevent: room-event\ndata: <json>\n\n`; `cursor`
   advances per event. Stops early if `res.writableLength > streamQueueCap`
   (lagging).
4. Typing indicators: synthetic `event: typing` with **no `id:`** — never
   disturbs Last-Event-ID resume. Emitted only when the visible typist set
   changes for this connection.
5. If lagging → `lag()`: one `event: stream_lagging` with "reconnect with
   Last-Event-ID to resume", then `setTimeout(() => res.destroy(),
   STREAM_DRAIN_GRACE_MS)` (5s). `drop.unref()`; cleared on close.
   Else `cursor = batch.next` — the cursor advances past invisible
   (redacted/filtered) rows only after the visible batch queued, so a
   lagging stream resumes from its last *sent* event.
6. Errors: 401/403 or `session_binding_changed` → `event: access-ended` and
   end; anything else → `event: unavailable` and end (client should reconnect).

## Disconnect

`cleanup()` clears the interval and removes the entry from `streams`.
Triggered by: `res` `close`/`finish`/`error`, request abort
(`resolveRequestSignal(req)` — the Workers Node bridge doesn't emit `close`
on browser navigation, so the platform signal is the release path), or an
already-aborted signal at connect (stream ends immediately, slot never
occupied — proven by `stream-lifecycle.test.js`).

`server.closeStreams()` ends every stream response (used by tests/shutdown).

## Backpressure model

- Per-connection: Node socket buffer + `streamQueueCap` (default 65536 bytes
  of `writableLength`). A consumer that never reads gets exactly one
  `stream_lagging` event and a 5s drain grace, then the socket is destroyed.
  Peers are unaffected (own queues).
- Global: 100 concurrent streams; excess → `429`. Producers (`store.command`)
  never block on consumers.
- Verified by `tests/stream-backpressure.test.js` and guild-12 fuzz F1/F13/F14.
