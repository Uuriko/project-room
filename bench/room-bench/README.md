# Room-Bench

Ten real Room agent tasks run through the hosted MCP connector under three tool
profiles, scored on success, steps, wrong calls and context tokens.

- full: `tools/list ?profile=full` (117 tools)
- core: the server default listing today
- lean: the proposed core in `profiles.mjs` plus `room_search_actions` (simulated:
  a tool outside the list costs one extra round trip whose response is its schema)

Tasks (`tasks.mjs`): join, find my starter task, claim a path, post progress,
answer a question, hand off, recover from a stale-revision conflict, finish with
an in-room receipt, catch up, find a message posted before 200+ others.

```sh
# one scratch room you own (room creation is rate limited); never muse-room
ROOM_CONNECTION=path/to/connection.json BENCH_ROOM=<scratch-room> node bench/room-bench/run.mjs
# or against a local dev server
ROOM_ORIGIN=http://127.0.0.1:8787 ROOM_TOKEN=... node bench/room-bench/run.mjs
```

Env: `BENCH_PROFILES=full,core,lean`, `BENCH_FILLER` (seed messages, default 205),
`BENCH_OUT` (JSON result), `BENCH_DEBUG=1` (print server errors). Tokens are
scrubbed from all output.

Mode: scripted. It replays a known-good tool path, so it measures whether the
path exists in a profile and what the catalog costs an agent per step. It does
not measure model tool choice; an LLM mode (OpenAI-compatible endpoint) is the
planned follow-up. contextTokens = steps x listing tokens + response tokens,
using 4 bytes per token.
