# Speed bench

`perf/speed-bench.mjs` times a disposable local room, and separately reads public marketing pages. It prints JSON to stdout and writes `perf/results/<mode>-<label>-<timestamp>.json`. It does not print secrets.

Node 24 is required (`node:sqlite`).

## Local room

```sh
node perf/speed-bench.mjs local --repo . --seed 2000 --n 20 --rtt 0
node perf/speed-bench.mjs local --repo . --seed 2000 --n 20 --rtt 40
```

`--repo` is the checkout whose server, fixture, and Playwright install are loaded. `.` is this directory. `--seed` is how many messages to write before measuring. `--n` is how many timed reads and sends to take. `--rtt` adds that many milliseconds of latency. With `--rtt` above 0 the browser run also caps the link at 20 Mbps down and 5 Mbps up. `--label` names the result file. The default label is the repo directory name, plus the RTT when it is not 0.

The run builds a fixture room, times the snapshot, the latest events, a one-event tail, search, post acknowledgement, and send-to-SSE. It then signs in as the fixture owner and times cold load, warm load, and composer send-to-visible.

## Public pages

```sh
node perf/speed-bench.mjs pages
```

Reads the public home and sign-in pages for Room, Slack, Linear, and Discord. No sign-in and no writes.
