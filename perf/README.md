# Perf benches

`perf/cold-send-bench.mjs` times a cold page load and one own send against a throwaway local server. It prints one JSON line. It used to be named `perf/interaction-bench.mjs`.

```sh
node perf/cold-send-bench.mjs
```

`COLD_SEND_BENCH_SAMPLES` sets the sample count (default 5). `INTERACTION_BENCH_SAMPLES` still works.

`perf/interaction-bench.mjs` is a different bench: room switch, channel switch, search, and DOM size. Keep that name for that program so the two files do not replace each other.
