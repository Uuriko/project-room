# herdr-bench results — session substrate benchmarks (lane P1)

**Harness:** `perf/herdr-bench.mjs` · **Run:** 2026-10-07 ~04:52 UTC (2026-10-06 21:52 PDT)
**Binary under test:** upstream `herdr` **0.9.3**, linux-x86_64, JSON socket protocol **22**
— downloaded from `https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-linux-x86_64`,
SHA-256 verified `18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7`
(matches `distribution/latest.json` in the pinned upstream tree). Read-only benchmark use;
no production code touched. **This is the upstream binary, not the B1 fork build** —
re-run against the stripped fork binary when it lands (same harness, `HERDR_BIN=...`).

**Host:** linux x64, node v24.20.0. Shared CI VM under load — p95s carry scheduling noise
(see §5); every run is hermetic (`HERDR_SOCKET_PATH` + `XDG_CONFIG_HOME` per run dir under `$TMPDIR`).

**Reproduce:** `HERDR_BIN=/path/to/herdr TMPDIR=~/workspace/pr-herdr-p1/.tmp node perf/herdr-bench.mjs`
(`--suite=a,b,c,d,e`, `--spawns=50`, `--out=results.json`, `--no-budget`, `--bin=`).

## 1. Results vs budgets

| Suite | Metric | p50 | p95 | Budget (p95) | Verdict |
|---|---|---|---|---|---|
| (a) spawn | `tab.create` (pane/PTY spawn, n=50) | 117.7 ms | 313.3 ms | < 2000 ms | **PASS** |
| (b) reattach | `server.stop` → pong (n=10) | 561.6 ms | 782.7 ms | — (info) | — |
| (b) reattach | `server.stop` → `session.snapshot` (n=10) | 944.1 ms | 2643.9 ms | < 10000 ms | **PASS** |
| (c) read | `pane.read` 1 KB payload | 14.7 ms | 105.0 ms | — (info) | — |
| (c) read | `pane.read` 16 KB payload | 69.1 ms | 202.2 ms | — (info) | — |
| (c) read | `pane.read` 64 KB payload (1000 lines) | 95.3 ms | 221.3 ms | — (info) | — |
| (c) read | capped 1000-line read over 1 MB scrollback | 162.1 ms | 222.1 ms | < 5000 ms | **PASS** |
| (d) bridge | hop overhead vs raw socket, paired (n=30) | **5.3 ms** | 170.0 ms | < 100 ms | **FAIL** (see §5) |
| (e) events | `pane.report_agent` → subscriber receipt (n=30) | 200.5 ms | 210.6 ms | < 500 ms | **PASS** |

Raw JSON: run dir under `$TMPDIR/herdr-bench-*/results.json` (full samples, not just percentiles).

## 2. Suite notes

**(a) Spawn.** `tab.create` spawns a real PTY shell per call — this is the `spawnAgent` analog.
p50 ~118 ms, p95 ~313 ms, max 590 ms over 50 spawns. Comfortably inside 2 s. Spawn cost is
dominated by PTY/shell fork, not socket IPC (raw `ping` RTT is ~13 ms p50).

**(b) Reattach.** Kill via `server.stop` RPC → respawn → poll connect → `ping` → `session.snapshot`.
Snapshot after restart restored all tabs every iteration (10/10) — herdr's `session.json`
persistence works as the durability story needs. stop→pong p50 ~560 ms is the cold-start floor
(process spawn + socket bind); the extra ~380 ms to snapshot is restore+serialize.

**(c) Read.** `pane.read` latency grows gently with payload: 15 → 69 → 95 ms p50 for
1 KB → 16 KB → 64 KB. A capped 1000-line read over a 1 MB scrollback costs 162 ms p50 —
scrollback depth adds modest cost, no cliff.

**(d) Bridge.** Reference bridge = harness-local HTTP→Unix-socket forwarder standing in for
`bridge/herdr-bridge.mjs` (B3). Decomposition over 30 interleaved iterations:

| Leg | p50 | p95 |
|---|---|---|
| raw socket `ping` (baseline) | 13.0 ms | 109.2 ms |
| Worker→bridge HTTP, localhost, no herdr (`/noop`) | 6.9 ms | 94.7 ms |
| bridged `ping` (total) | 23.4 ms | 184.0 ms |
| **hop overhead, paired (bridged − raw)** | **5.3 ms** | 170.0 ms |

The intrinsic hop cost is **~5–7 ms p50, stable across 3 runs**. The p95 budget miss is
environmental (see §5), not architectural.

**(e) Events.** Self-reported state change (`pane.report_agent` working↔blocked, alternating to
force a transition) → `pane.agent_status_changed` on a persistent `events.subscribe`
connection: p50 ~200 ms, p95 ~211 ms, max 242 ms. Well inside 500 ms.

## 3. Bottleneck analysis

1. **Event propagation (~200 ms p50) is the slowest per-op substrate cost after spawn.**
   A local socket event taking 200 ms suggests server-side dispatch batching/debounce, not
   transport. For the supervision inbox (B6), which keys off these events: budget one
   event→card pipeline accordingly; do not assume sub-50 ms reactivity. Worth one profiling
   pass on the fork (B1/B10) to see if the delay is the detection pipeline or hub fan-out.
2. **Spawn (~120 ms p50) is PTY-bound.** Fine for lane startup; not fine for per-message
   churn — the adapter should keep panes warm and reuse, never spawn-per-task.
3. **Reattach (~0.9 s p50 to snapshot) is process-spawn-bound.** Acceptable for broker
   restarts; the adapter's reconnect path should ping-gate then snapshot (exactly what the
   harness does) and treat >10 s as broker-down → fail closed to legacy.
4. **Read scales linearly-ish with bytes, no cliff to 1 MB scrollback.** The binding
   constraint is not latency but the **1000-line cap** (§4).

## 4. Protocol findings for the B-lanes (from building the harness)

- **One request per connection.** The server answers a normal RPC then *closes* the
  connection. `events.subscribe` is the only long-lived connection (response, then
  `{"event","data"}` envelopes pushed per line). The adapter (B2/B4) must use
  one-shot connections per call — no connection pooling across calls, one persistent
  connection per subscription. (Found the hard way: pipelining two requests on one
  connection hangs the second forever.)
- **No connect handshake; ping-gate instead.** `ping` → `{version, protocol, capabilities}`;
  fail closed unless `protocol === 22`. Re-gate per connection, not just at startup.
- **`pane.read` hard-caps at 1000 lines** (`src/app/api_helpers.rs:117`,
  `lines.min(1000)`), end-anchored, `truncated: true` beyond. There is **no offset/cursor
  param** — a >1000-line backlog cannot be fully retrieved through `pane.read` alone.
  `readPane` (B2) must document the ceiling; large outputs need `pane.scroll`+`visible`
  paging or `wait_for_output` sentinels. Secret hygiene stands: never log read output.
- **`events.subscribe` is pane-scoped for status events**:
  `{subscriptions: [{type: "pane.agent_status_changed", pane_id}]}` — `pane_id` is required.
- **Self-report races the detection engine.** After `pane.report_agent(state=blocked)`,
  the server emitted our event and then a second `agent_status_changed` → `unknown`,
  i.e. the screen-heuristic engine overwrote the self-report within ~300 ms. This
  confirms the REDESIGN decision to strip/disable the detection engine in the fork —
  otherwise lane state flaps. Until the fork lands, the adapter should treat the
  *first* post-report event as authoritative and debounce follow-ups.
- **`herdr server` daemonizes.** The child exits after printing "herdr server running";
  the daemon holds the socket. The bridge (B3) must supervise via `server.stop` RPC
  (graceful, verified) and treat a missing socket as "start it", not as an error.
- **`workspace.create` auto-creates a root pane**; `tab.create` needs an existing
  workspace (`workspace_not_found` otherwise). `tab.close` takes `{tab_id}`.
- **Pane shells inherit the server's environment.** The bridge must scrub env for
  per-tenant isolation (REDESIGN §5 already calls for per-tenant `TMPDIR`/UID).

## 5. The (d) budget miss — environmental noise, not a regression

`bridge overhead p95 < 100 ms` **FAILED** (170 ms) on the full run. Two dedicated
re-runs of suite (d): overhead p50 = 7.2 / 6.1 ms (stable), p95 = 103.5 / 127.2 ms.
The raw-socket `ping` baseline itself showed p50 swinging 13 → 102 ms between runs on
this shared VM — the p95 noise floor of the machine exceeds the budget. The intrinsic
hop cost (paired p50, same-process, same-minute) is unambiguous: **~5–7 ms**, i.e. the
Worker→bridge→socket split adds single-digit milliseconds. The budget stays as the
failing-until-met gate; re-run on a quiet host (or the fork binary) is expected to pass.
Do not "fix" this by relaxing the budget to fit a noisy box.

## 6. Open items / follow-ups

- Re-run this harness against the **B1 stripped fork binary** when it lands — expect
  equal-or-better numbers (less code in the hot path); any regression is a fork bug.
- Profile the ~200 ms event-dispatch latency (B10 fork-audit or B3).
- Suite (d) should be re-run against the **real** `bridge/herdr-bridge.mjs` (B3) with
  auth+allowlist+audit enabled to measure their marginal cost over the reference bridge.
- Consider adding a `pane.read` pagination story (offset param) to the fork if the
  adapter needs full-backlog reads — currently impossible via the API.
