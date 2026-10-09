# Resume semantics (Last-Event-ID)

## Protocol

- The client sends the last processed event id as the `Last-Event-ID` header
  or `?after=` query param. Header wins when both present.
- `after = Number(header ?? query ?? 0)`. Missing/empty → `0` → full replay
  from the start of visible history (bounded: 100 events per pump batch).
- Every `room-event` carries `id: <sequence>`. `typing` events carry **no id**
  and never move the resume cursor.

## Server validation (`store.eventsAfter`)

| Input | Result |
|---|---|
| non-safe-integer, negative, `NaN` (`"abc"`, `"1e21"`, unicode, 100KB) | `422 invalid_cursor` |
| `after` > room sequence | `409 cursor_ahead` ("fetch a fresh snapshot") |
| valid id | replay of events with `sequence > after`, 100/page via `batch.next` |

## Cursor advancement rule

`cursor = batch.next` only after the whole visible batch was queued. If the
consumer lags mid-batch, `cursor` stays at the last *sent* event, so
reconnecting with Last-Event-ID replays exactly the unsent remainder — no
gaps, no dupes beyond the in-flight batch. (A reconnect may re-receive the
last in-flight batch's tail; consumers must be idempotent on `id:`.)

## Fuzz evidence (guild-12)

- F3: valid resume from `seq-2` delivered exactly the 2 newer events; resume
  at the tip delivered zero events (clean). PASS.
- F4/F5/F6: pending at doc time — results land in `11-fuzz-load-report.md`.
  Design: F4 future cursor (expect `409`, no hang); F5 twelve garbage cursors
  (expect all `4xx`, zero `500`s); F6 header-vs-query precedence + malformed
  request matrix.

## Gotcha

`eventsAfter` runs **before** the 100-stream limit check in `stream()`. A
client holding a stale/invalid cursor gets its cursor error even when the
room is at the stream cap — cursor validation is not starved by load.
