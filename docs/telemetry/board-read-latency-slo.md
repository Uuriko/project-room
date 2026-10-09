# Board-read latency SLO + contention attribution (FIX-78)

Evidence that motivated this: board reads observed at 2.7–13.8s, with >60s
hangs in a near-empty room — and no way to tell WHY the board was slow.
`scripts/board-read-probe.mjs` answers the "why" by attributing each read
into **server** vs **network** vs **contention**.

This is ATTRIBUTION only. It does not make the board faster.
FIX-54 (telemetry collector) and FIX-55 (in-room digest) are separate work.

## The SLO

| Target | Value |
|---|---|
| p50 (single board read) | ≤ 1500 ms |
| p99 (single board read) | ≤ 5000 ms |
| Read timeout rate | ≤ 5% (timeout = 30s) |
| Contention share | < 30% of ladder p50 at any rung |

**BREACH** means: over one probe run, p99 > 5000ms, OR >5% of reads time
out, OR contention exceeds 30% of the ladder p50 at any concurrency rung.
A single slow read is not a breach — the SLO is on the run's p50/p99.
The probe prints a `verdict` object with exactly these checks.

## How to run the probe

```sh
# Against the live room (default target: the work-claims board):
node scripts/board-read-probe.mjs --room muse-room --runs 10 --ladder 1,2,4,8

# Pretty output:
node scripts/board-read-probe.mjs --pretty --runs 5 --ladder 1,2,4

# Against a fixture / staging host:
node scripts/board-read-probe.mjs --base-url http://127.0.0.1:PORT --path /board

# Auth (else $ROOM_IDENTITY_SECRET):
node scripts/board-read-probe.mjs --bearer <token> --header "x-custom: yes"
```

Output is JSON on stdout: `target`, `slo`, `baseline` (concurrency-1 reads),
`ladder` (per-rung summaries + attribution), `method` (which attribution path
was actually available), and `verdict`.

The probe tags every request with `x-probe: board-read-probe` and
`x-probe-concurrency: <n>` — operators can filter probe traffic out of real
metrics, and test fixtures use the concurrency tag to model queueing.

## How attribution works

Per read, the probe records:

- `connectMs` — TCP+TLS(+DNS) handshake, measured from socket events when a
  genuinely new socket is created (0 on keep-alive reuse; the probe uses one
  keep-alive pool per origin so ladder reads genuinely overlap — fresh
  connections per read serialize and can never contend).
- `ttfbMs` — time to response headers.
- `totalMs` — time to full body.
- `serverMs` — parsed from the `Server-Timing` response header (sum of all
  `dur=` values) **when the API emits it**.

Buckets:

- **server** — `serverMs` from Server-Timing. The live room API does **not**
  emit `Server-Timing` (verified 2026-10-09), so in practice this is null and
  server+network are reported as one combined **`serverNetworkMs`** bucket
  (`ttfb − connect`). The split is honest about what the API supports; if the
  API ever emits Server-Timing, the probe picks it up with no changes.
- **network** — `ttfb − connect − server`: wire transit **plus** any
  server-side wait the API didn't report. Server-Timing normally measures
  handler time, not queue wait — so per-read, queueing hides inside this
  bucket. The ladder is what pulls it back out (below).
- **body** — `total − ttfb`: response-body transfer time (network).
- **contention** — never a per-read value (always 0 per read). Estimated per
  ladder rung: `contention(N) = max(0, p50(N parallel readers) − p50(baseline
  solo))`. The delta isolates queueing/lock contention from everything else.

## How to read a result — "why is the board slow?"

1. Look at `verdict.breach` and `verdict.breaches` first.
2. If `baseline.summary.p99` is high but ladder contention is ~0 at every
   rung: the slowness is NOT load-induced. Check the per-bucket medians —
   `serverMs` (or `serverNetworkMs` when Server-Timing is absent) vs
   `networkMs` vs `connectMs` — to see whether it's processing or transit.
3. If contention grows with the rung (e.g. 50ms at 2 readers, 400ms at 8):
   the board serializes readers — queueing/locking on the server. That is
   the "near-empty room, >60s hangs" signature: even a few concurrent
   readers pile up.
4. If `timeouts`/`errors` are nonzero: reads are failing outright, not just
   slow — check server health, not latency buckets.
5. `method.serverTimingPresent: false` is expected against the live API;
   `true` means a future API version started emitting Server-Timing and the
   server/network split is now exact.

## Running the acceptance tests

```sh
TMPDIR=$PWD/.tmp node --test tests/board-read-probe.test.js
```

The suite spins up a fixture HTTP server that injects a known delay into
exactly one bucket at a time (server sleep reported via Server-Timing,
body-chunk delays for network, rendezvous-barrier queue waits for
contention) and asserts the probe attributes each to the right bucket —
including that queueing is NOT misattributed to the server bucket and that
no contention is reported when there is no queueing.
