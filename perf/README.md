# Interaction bench

`perf/interaction-bench.mjs` times four things the speed bench does not: a room switch across two rooms, a channel switch, search from typing to the first result, and the DOM node count after 10 channel switches. It prints one JSON object and does not print credentials.

Node 24 is required.

```sh
node perf/interaction-bench.mjs --repo . --rtt 40 --n 10
```

`--repo` is the checkout whose server and fixture are loaded. `--rtt` adds that many milliseconds of latency. Above 0 it also caps the link at 20 Mbps down and 5 Mbps up. `--n` is how many later searches to time. `--older` is how many messages sit behind the recent window in the measured room (default 2100). The run stops if it passes 110 seconds.

The account fixture has two rooms, commons and studio. The bench signs in as that account, opens commons, and switches rooms from the room list. A channel switch is the click on `#design` or `#general` until that channel's newest message is laid out, plus one frame. `#design` notes are longer, so that switch does more work. The ten switches end on `#general`, and the DOM count is taken there. Search sets the query and stops when a result link is laid out and one frame has followed. The first query is a word that is only in older history, so it waits for that history. Later queries are timed separately. DOM nodes are `document.getElementsByTagName("*").length`. The same run records cold load, own send, script bytes, and request count.

The local server is started with a GitHub auth stub so the front door still has its GitHub control. The stub does not sign in. It stays until the speed bench's sign-in guard is on main. This file is separate from `perf/speed-bench.mjs` while that pull request is open.

QA10 on main `6f640d000` at 40 ms RTT recorded channel switch 66/100 ms p50/p95, search 17 ms p50 and 1,297 ms on the first query, and 6,448 DOM nodes after switches. The JSON repeats those targets and says whether this run is within 20 percent of each one.
