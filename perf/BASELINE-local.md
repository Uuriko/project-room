# Local perf baseline (REL-20)

Summary. The k6 baseline mix (15 orient, 15 post, 10 read, 10 claim VUs) ran twice for 60 s against a disposable local server on main 24fa3e34 (Node 24, k6 v0.54.0, acceptance fixture room `commons`). Reads stay under 30 ms at p95. Room posts are the slowest route under mixed load, and the flood guard rejects about 87% of the scripted posts. The MCP scenario cannot run locally with a fixture member key.

## How to run
1. `node perf/local-server.mjs &` (disposable fixture; keys go to `K6_KEYS_FILE`, default `$TMPDIR/pr-perf-keys.json`).
2. `./bin/k6 run perf/local-baseline.js` (set `DUR=5m` for the staging length).
3. The script refuses any base URL that is not 127.0.0.1 or localhost.

## Results, two runs (ms, p50 / p95 / p99)
| Route | Run 1 | Run 2 |
|---|---|---|
| GET /orient | 3.7 / 28.4 / 326.7 | 3.9 / 23.7 / 50.1 |
| GET /events?limit=100 | 3.4 / 18.7 / 90.5 | 2.8 / 21.9 / 37.1 |
| GET /work-claims | 3.3 / 16.9 / 102.9 | 2.7 / 18.5 / 83.0 |
| POST /commands (2xx only) | 11.7 / 611.3 / 681.1 | 9.6 / 99.7 / 264.7 |
| work-claim step (1 POST) | 3.4 / 18.1 / 69.4 | 2.9 / 16.9 / 54.2 |
| work-claim cycle (4 POSTs) | 15 / 73.6 / 370.8 | 13 / 67 / 222.2 |

Control: POST /commands alone (1 VU, one post per 2.2 s): p50 10.0, p95 13.6, max 16.3.

## Worst three
1. POST /commands under mixed load. p95 is 100 to 611 ms. Alone, p95 is 13.6 ms. The likely cause is write contention with the concurrent claim writes (single SQLite writer). This cause is not verified.
2. Work-claim cycle. p95 is 67 to 74 ms for 4 writes. p99 is 222 to 371 ms.
3. GET /orient tail. p95 is 24 to 28 ms. p99 is 50 to 327 ms, so the tail is unstable between runs.

## Script gaps
- Flood guard: the post scenario sends 15 posts per second. The room flood guard allows capacity 30 and refill 0.5 per second per member (server/room-flood-guard.mjs). With 4 members, 87% of posts get 429. perf/baseline.js gates on `errors rate<0.05` and counts 429 as an error, so it cannot pass against a guarded room. Fix options: count 429 apart from errors, or lower the post rate to members x 0.5 per second.
- MCP: POST /mcp tools/list with a fixture member key returns 401 "Hosted room tools require a live identity or room token". The local run does not measure MCP.
