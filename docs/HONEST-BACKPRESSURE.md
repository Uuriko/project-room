# Honest Backpressure

**Status:** wave300, coordinator 3/10. Replaces silent queueing with truthful
load shedding. Spec: `docs/HONEST-BACKPRESSURE-SPEC.md`.

Core axiom: **you can't back off from silence.** A client that times out with
no status learns nothing and retries blindly, which is how a probe storm
becomes a self-DDoS. Every refusal below is fast (microseconds-to-milliseconds)
and says exactly why, with a `Retry-After` the client can honor.

## The three work items

1. **No-rearm penalty box** — `rate()` in `server/http.mjs`: a refused request
   no longer consumes budget, extends its window, or rewrites the durable
   abuse bucket; every 429 carries `Retry-After`.
2. **Command admission gate** — `POST /api/rooms/{roomId}/commands` refuses
   fast with 503 `shed_load` (never silently queues) when the in-flight
   command gauge is full.
3. **Probing-intent admission** — `POST /api/admission/intent` (this doc's
   focus): declare what you are about to probe; the server admits or refuses
   in microseconds.

## POST /api/admission/intent

Unauthenticated by design — a client asking "may I probe?" must not need the
credential it is probing toward. The per-client budget keys on the bearer
credential's hash when an `Authorization` header is present, otherwise on the
remote address.

Request (all fields required except `notes`; unknown fields are rejected):

```json
{
  "kind": "read | write | flood | mint | join | claim-update",
  "target": "muse-room | scratch:<room-id> | api:<route-path>",
  "rate_rps": 0.5,
  "expected_total": 200,
  "window_seconds": 1800,
  "notes": "optional free text, at most 2000 chars"
}
```

- `target` must name the exact room or route. `"production"` alone is not a
  target (400 `invalid_intent`).
- `rate_rps` must be a finite number > 0; `expected_total` a positive integer;
  `window_seconds` a positive integer of at most 3600.
- Malformed intents are `400` with `error.code: "invalid_intent"` (the standard
  error envelope).

### Admit — 200

```json
{ "admitted": true, "intentId": "<uuid v4>", "budget": { "rate_rps": 0.5, "expected_total": 200 } }
```

### Refuse — 429 or 503, both with `Retry-After`

```json
{ "admitted": false, "code": "over_budget | shed_load", "retryAfterMs": 1234, "reason": "..." }
```

| Status | `code` | Meaning |
|---|---|---|
| 429 | `over_budget` | The client already holds 3 concurrent active intents. `retryAfterMs` is the milliseconds until the earliest active intent's window expires. |
| 503 | `shed_load` | The server is shedding load. The intent is not admitted. |

**The `Retry-After` contract:** every refusal carries a `Retry-After` response
header in **seconds**, equal to `ceil(retryAfterMs / 1000)` of the body. Honor
the header; if you only parse the body, use `retryAfterMs`. Do not retry
before the delay elapses — on 429 an early retry is still over budget, on 503
it lands in the shed pile.

Why 429 vs 503: 429 means *you specifically* are over your quota (reduce your
concurrency); 503 means *the server* is shedding (back off and retry later).
Different client behavior, hence different statuses.

### Intent semantics: advisory, not a reservation

- Declaring an intent is a courtesy signal, not a lock. The server does not
  reserve capacity for admitted intents and admitted intents get **no
  priority** — the server-side gates (the write limiter, the command admission
  gate) remain the enforcement. A probe that ignores a refusal, or probes
  without declaring, meets those gates exactly as before.
- Well-behaved clients (our own swarm workers) declare first and route around
  refusals: pick another target, shrink the window, or wait out `Retry-After`.
- Admitted intents are tracked in a bounded in-memory registry (1024 rows,
  per server instance) used only to count each client's concurrent active
  intents. Refusals write nothing — not even a counter row — so a retry storm
  cannot amplify server-side work.

### Backward compatibility for existing clients

- The route is purely additive: no existing route changed shape or behavior.
- Clients that never declare intents see no behavior change at all.
- The 429/503 refusal shapes are safe to treat as retryable by generic HTTP
  clients: a client that retries any 429/503 after `Retry-After` does the
  right thing without knowing this spec. Unknown JSON fields in the body are
  safe to ignore.
- The 400 `invalid_intent` shape is the standard error envelope
  (`error.code`, `error.message`), like every other input refusal.

## For operators

- `setIntentAdmissionShed(active)` in `server/http.mjs` is the hook the live
  load gauges drive. TODO (coordinator 4/10): feed it from the command
  in-flight shed counter, event-loop lag estimate, and load-calendar
  thresholds so `shed_load` refusals reflect real server load. Until then the
  endpoint refuses only on per-client budget (429); the 503 path is wired and
  tested but dormant.
- `intentAdmissionStats()` exposes `{ admits, refusedOverBudget,
  refusedShedLoad, shedding, activeIntents }` for dashboards.
