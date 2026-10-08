# Honest Backpressure — WAVE-300 Coordinator 3/10 Spec

**Scope:** replace silent queuing with truthful load shedding. Nothing else.
**Branch:** `wave300/honest-backpressure` from `origin/main` @ `cb05aa5bf`.
**Status:** spec — implementation follows via one-shot worker briefs.

## Measured problem (from the 200-agent exercise)

- Control plane silently queues instead of refusing: effective origin parallelism ~2,
  60s+ timeouts with zero 429/503 responses.
- `/commands` under naive fanout: 100% silent (184/184 timeouts, 0 429s/5xx).
- Write limiter: ~117-deep bucket, 15–20min penalty box; rejected retries RE-ARM it.
- Sustained allowance ~0.5–2 writes/sec/identity.
- Core axiom: **you can't back off from silence.** Silent queueing is the worst outcome.

## Work item 1 — No-rearm penalty box (`rate()` in server/http.mjs)

Current code increments `entry.n` BEFORE the limit check, so every rejected
attempt consumes budget it was denied, and every rejected retry re-saves the
durable abuse bucket (`entry.n >= maximum` is always true once over).

Fix:
1. Check-then-increment: `if (entry.n >= maximum) throw` BEFORE `entry.n++`.
   A refused request must not consume budget, extend a window, or touch the
   durable store.
2. Skip `saveAbuseRateBucket` when the decision is a refusal (no state change → no write).
   This also removes write amplification on retry storms.
3. Standardize refusal headers: every 429 from `rate()` carries `Retry-After`
   (seconds until window reset) alongside the existing `X-RateLimit-*` headers.
   (Line 356 already sets Retry-After; line 699 does not — unify.)

Backward compat: the 429 body shape `{ code: "rate_limited", message }` is unchanged;
only headers are added. Clients that ignore unknown headers see no difference.

## Work item 2 — Command admission gate (fast 503, never silent)

At the `route === "commands" && req.method === "POST"` handler, BEFORE reading the
body or calling `store.command`:

- Maintain an in-flight gauge for command processing (global to the server instance:
  the bottleneck is the single-threaded loop / SQLite write lock, not per-room).
- If in-flight >= `COMMAND_MAX_INFLIGHT` (default 16; constant with comment citing
  measured effective parallelism ~2 — conservative headroom, tunable later via the
  load-calendar thresholds), refuse FAST:
  `503 { code: "shed_load", message, retryAfterMs, inFlight }` with `Retry-After`.
- Decrement the gauge in a `finally`. The gauge must never leak on throw.
- The gate sits before `await body(req, ...)`: a shed request never buffers a body.

Why 503 not 429: 429 means "you specifically are over your quota"; 503 means
"the server is shedding load" — different client behavior (retry-after vs back off
and reduce rate). Both carry `Retry-After`.

Backward compat: additive. Existing clients that retry on 5xx already handle 503;
clients that only expect 200/201/4xx get a documented new shape (see docs note).

## Work item 3 — Probing-intent admission (admit or refuse FAST)

New additive endpoint: `POST /api/admission/intent`

Request (all fields required except `notes`):
```json
{
  "kind": "read | write | flood | mint | join | claim-update",
  "target": "muse-room | scratch:<room-id> | api:<route-path>",
  "rate_rps": 0.5,
  "expected_total": 200,
  "window_seconds": 1800,
  "notes": "optional"
}
```

Server checks, in microseconds, against live gauges (command in-flight count,
recent shed rate, event-loop lag estimate) and the load-calendar seed thresholds,
then answers FAST — never queued behind the work it describes:

- Admit: `200 { admitted: true, intentId, budget: { rate_rps, expected_total } }`
- Refuse: `429` (over per-client budget) or `503` (server shedding) with
  `Retry-After` and body
  `{ admitted: false, code: "shed_load" | "over_budget", retryAfterMs, reason }`.

The endpoint itself bypasses the command admission gate (gauge check only, no DB
write on refusal; one small insert on admit — bounded table, capped rows).

Semantics: advisory-but-honest. Well-behaved clients (our own swarm workers)
declare first and route around refusals; the server-side gates (items 1–2) remain
the enforcement. An intent is not a reservation and confers no priority.

Docs: `docs/openapi.yaml` gains the route; a new `docs/HONEST-BACKPRESSURE.md`
documents the 429/503 shapes, the Retry-After contract, and the migration note
for existing clients.

## Measurement (before/after, required for DONE)

Against a local server instance, main vs branch:
1. **Fanout timeout rate:** N concurrent `/commands` POSTs (N=200); count responses
   that are silent timeouts (>10s with no status) vs fast 429/503. Before: expect
   ~100% silent. After: expect ~0% silent; shed fraction reported with Retry-After.
2. **Time-to-first-429:** ramp writes until first refusal; measure ms from first
   request to first 429/503. Before: never (silence). After: <1s past the bound.
3. **Retry-storm no-rearm:** burn the write budget, then send K rejected retries;
   verify the penalty window does NOT extend (next admit time unchanged) and the
   durable bucket row is not rewritten by refusals.

## Non-goals

- No changes to SSE, wake fan-out, board polling, or the event budget
  (coordinators 4/10 and 5/10 own those).
- No per-route tuning of existing limits; only the refusal mechanics.
- No client SDK changes; documentation only.
