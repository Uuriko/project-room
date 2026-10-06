# Soak test (Q007) — 24-hour event-loop soak harness

An observe-only harness that runs the real server under sustained HTTP load
and fails on memory leaks, event-loop lag, file-descriptor growth, unhandled
rejections, or crashes. It never changes server behavior: instrumentation is
loaded into the server process with `node --import` (see
`scripts/soak-preload.mjs`), and no file under `server/` is touched.

## Files

| File | Role |
|---|---|
| `scripts/soak-run.mjs` | Orchestrator: boots the server on a scratch DB, drives load, evaluates, writes the report, exits 0/1/2 |
| `scripts/soak-preload.mjs` | Observe-only in-process instrumentation (lag sampler, heap/FD samples, rejection recorder) + fault-injection flags for the failing-first proof |
| `tests/soak-leak-detection.test.js` | node:test: proves the harness FAILS on an injected leak, PASSES clean, FAILS on an injected rejection |
| `.github/workflows/soak-test.yml` | CI job: the bounded 15-minute version, weekly + manual |

## Quick start

```sh
# 15-minute bounded run (what CI does)
SOAK_DURATION_S=900 SOAK_LOAD_RPS=10 SOAK_CRASH_RECOVERY=1 node scripts/soak-run.mjs

# short local smoke (~40 s)
SOAK_DURATION_S=40 SOAK_LOAD_RPS=5 node scripts/soak-run.mjs

# failing-first proof by hand: this MUST exit 1 with a heap-growth failure
SOAK_DURATION_S=45 SOAK_INJECT_LEAK=1 SOAK_MAX_HEAP_GROWTH_MB=8 node scripts/soak-run.mjs
```

The report lands at `$SOAK_REPORT_PATH` (default: a fresh temp dir) as
`soak-report.json`, and a human-readable summary prints to stdout.

## What it checks

| Signal | How | Default fail threshold |
|---|---|---|
| Memory growth | median heapUsed, last 10% of samples vs first 10% | `SOAK_MAX_HEAP_GROWTH_MB=25` MB |
| Event-loop lag | 100 ms sampler drift, p99 over the run | `SOAK_MAX_LAG_P99_MS=250` ms |
| FD growth | `/proc/self/fd` count, last vs first sample (Linux) | `SOAK_MAX_FD_GROWTH=25` |
| Unhandled rejections | recorded by the preload, then rethrown so the crash still happens | any → fail |
| Crash | child exit code/signal during the run or at shutdown | any → fail |

Boot cold-start, a 5 s post-ready warmup, graceful-shutdown work, and (when
enabled) the crash-recovery restart window are excluded from evaluation —
they block the loop for legitimate one-off reasons. Excluded windows are
listed in the report under `metricsExclusions`.

## Crash-recovery leg

`SOAK_CRASH_RECOVERY=1` SIGKILLs the server mid-run (`SOAK_CRASH_AT_S`,
default 300), restarts it on the same DB and port, and measures downtime.
The intentional SIGKILL is not a failure; failing to come back is.

## The full 24-hour run

GitHub-hosted runners cap a job at 6 hours, so the 24 h run is manual on a
persistent machine:

```sh
# on a machine that stays up; run under tmux/screen or nohup
SOAK_DURATION_S=86400 SOAK_LOAD_RPS=10 SOAK_CRASH_RECOVERY=1 \
  SOAK_CRASH_AT_S=43200 \
  SOAK_REPORT_PATH=~/soak-24h-report.json \
  node scripts/soak-run.mjs
```

Expect roughly: heap growth well under 25 MB (a healthy run stays nearly
flat), lag p99 under 250 ms, FD count flat, zero rejections, zero crashes,
and crash-recovery downtime of a few seconds (cold start on the same DB).

Interpreting a failure:

- **heap growth**: take two heap snapshots (`--heap-prof` is not needed —
  rerun with `NODE_OPTIONS=--inspect` and compare in DevTools) and look for
  retained collections keyed by request/room id. Growth that tracks request
  count is usually a per-request cache without eviction.
- **lag p99**: correlate with the server's job schedulers (growth,
  channel-drain, retention); a lag spike aligned to a scheduler tick points
  at synchronous work that should be chunked.
- **fd growth**: check for unclosed sockets/streams per request; `ls
  /proc/<pid>/fd` while it runs.
- **unhandled rejection / crash**: the report carries the first rejection
  message; the server log carries the stack.

## Failing-first proof

The harness is only trustworthy if it can fail. `tests/soak-leak-detection.test.js`
proves three things against the real server:

1. `SOAK_INJECT_LEAK=1` (preload retains ~1 MiB/s on the V8 heap) → exit 1,
   failure names heap growth.
2. Clean short soak → exit 0, no failures.
3. `SOAK_INJECT_REJECTION=1` → exit 1, failure names the unhandled rejection
   and the crash.

Run it with `TMPDIR=<worktree>/.tmp node --test tests/soak-leak-detection.test.js`.
It takes ~2 minutes (three real server boots).

## Limitations

- Load is synthetic GET traffic on public endpoints (`/api/health`,
  `/.well-known/agent-card.json`, `/growth/health`, `/`); it exercises the
  HTTP stack, routing, and store reads, not authenticated write paths.
- The 15-minute CI version cannot catch leaks slower than ~25 MB / 15 min;
  the 24 h run is the real leak detector.
- FD sampling is Linux-only (`/proc/self/fd`); elsewhere the FD check is skipped.
