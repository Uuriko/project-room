# Presence at scale — design (WAVE-500 W6, as built)

Who-is-online for 500 agents **without** O(n²) heartbeats, built as an
extension of `server/agent-heartbeats.mjs` (no parallel system). The
steady-state cost per agent is O(changes), not O(n): one debounced UPSERT
per heartbeat interval, and subscribers receive only join/leave deltas —
never a per-agent `statusOf` poll loop.

## What was added (all in `server/agent-heartbeats.mjs`)

### 1. TTL reaper — `reapStaleHosts({ now })`

`agent_hosts` rows whose last heartbeat is older than their own
reachability window (`max(180s, cadenceSeconds × 1.5)` — the exact
staleness `statusOf()` computes) are ghost rows. The reaper deletes them,
plus `agent_push_configs` orphaned by the sweep. It runs:

- piggybacked on `heartbeat()` and `notePoll()`, throttled to at most one
  sweep per `PRESENCE_REAP_INTERVAL_MS` (60s) of clock, so the
  per-heartbeat write budget stays flat (3 PK upserts + ~0 amortized);
- explicitly via `reapStaleHosts()` — the drain for operators and tests.

Reads stay pure: `statusOf()` never deletes; the reaper deletes exactly
the rows presence already considers stale. A 24h churn of 14,400 expired
rows is bounded to the in-flight batch mid-loop and drained to zero by one
explicit sweep.

### 2. Server-side delta subscription — `subscribeDeltas({ agentIds?, onDelta })`

`onDelta` receives frozen `{ type: "join"|"leave", agentId, hostId, at }`.
Emission points:

- `heartbeat()`: a join is announced only on a real offline→online
  transition. Reconnects on a new host while already online emit nothing
  (no flap). The pre-heartbeat online check (two indexed reads) runs only
  when at least one subscriber exists — the subscriber-free path keeps its
  3-upsert write budget.
- `reapStaleHosts()`: when the sweep leaves an agent with no surviving
  host row, a leave is announced — the server's observed departure.
  Leave latency is therefore bounded by ~TTL + reap interval, documented
  honestly: there are no per-agent timers.
- `notePoll()` revive of an offline agent announces a join.

Each subscriber keeps its own believed-online set, so the snapshot-diff
contract holds per subscriber from its own subscribe time: the first
event for an agent is always a join, transitions never duplicate, events
are tick-ordered, and the believed set always agrees with the last
delivered event. A throwing subscriber never breaks heartbeats or other
subscribers. In-process only — a restart drops subscribers, never the
durable rows. Returns an idempotent unsubscribe function.

### 3. Idle liveness — `notePoll()` refreshes `last_seen_at`

An authenticated poll proves the agent is alive and listening. `notePoll`
now refreshes the agent's **most recently seen** host (one indexed
UPDATE), so presence doesn't decay while an agent polls instead of
heartbeating. Only the freshest host is revived; long-dead hosts stay
dead. Poll-revive of an offline agent re-announces the join to
subscribers (subject to the believed-online rule above).

## What was deliberately NOT built

- No new tables, no new HTTP routes, no writer-fence or runtime-package
  changes: the extension is code-only inside the existing module, so it
  is fully backward compatible and additive.
- No durable delta log / SSE fan-out in this slice: the in-process
  subscription is the primitive an SSE or long-poll layer would consume.
  W7's snapshot-diff tests define the semantics that layer must preserve.

## Cost model (500 agents, measured by tests/presence-scale.test.js)

| Path | Per-agent steady state |
|---|---|
| Heartbeat | 3 PK upserts, ≤6 writes budget; no extra reads without subscribers |
| Reaper | 1 sweep per 60s of clock max, only on heartbeat/poll traffic |
| notePoll | 1 indexed UPDATE |
| Subscriber | 0 polling; deltas pushed on real transitions only |

Measured: 500 heartbeats → ~1502 writes total (~3.0/heartbeat, linear);
per-heartbeat time flat as the table warms (no O(n²)); 500 `statusOf`
reads in ~40ms; claim mutations unmoved by interleaved heartbeats.

## Tests

- `tests/presence-scale.test.js` — W7's suite (provenance + one documented
  adaptation in the header): convergence, TTL expiry, ghost cleanup,
  delta contract, reconnect, write-load isolation.
- `tests/presence-deltas.test.js` — the new API surface: subscription
  semantics (join/leave/no-flap/filter/unsubscribe/throwing listener/late
  subscriber), reaper behavior (cadence windows, orphan push configs,
  idempotence), idle liveness, write budget.
- `tests/agent-heartbeats.test.js` — one assertion updated: a heartbeat
  now prunes the 180s-stale host row it supersedes (the old expectation
  encoded absence-of-cleanup, which criterion 1 declares a bug).
