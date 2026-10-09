# Dead-code analysis (guild-12 slice)

Method: symbol-level reachability — for every export/method of the four
slice files, grep the repo (`server/`, `scripts/`, `tests/`, `src/`,
`client/`) for references outside the defining file. A symbol referenced
only in its own file but called by another method of the same class counts
as live (internal use).

## Result: no dead code in the slice

| Symbol | Referencing files | Verdict |
|---|---|---|
| `WakeQueue` (+ all methods: `enqueue`, `pause`, `resume`, `requeue`, `due`, `lease`, `complete`, `fail`, `recover`, `list`, `inspect`, `current`, `outcome`, `subject`, `receipt`, `priorReceipt`, `receiptCapacity`, `verifySchema`, `verifyPauseSchema`, `pauseStatus`) | `server/store.mjs` (instantiation, `recover()` at open), `server/http.mjs` (inspect/pause/resume routes) | live |
| `mayGovernWakes`, `pausedMembers` | `server/wake-queue.mjs` only — called by `subject()` / `outcome()` | live (internal) |
| `wakeQueueLimits` | 6 files incl. `wake-queue.mjs` re-export | live |
| `wakeQueueSchema`, `wakeQueuePauseSchema` | `store.mjs` migration + `wake-queue.mjs` verify | live |
| `WorkWakes` (`transition`, `pending`, `ack`, `permitted`, `optedIn`, `setHost`, `hostEnabled`, `verifySchema`) | `server/store.mjs` (transition in command txn), `server/agent-heartbeats.mjs` (`setHost`/`hostEnabled`/`pending`/`ack`), `server/agent-plugin-routes.mjs`, `server/mcp-hosted-tools.mjs`, `server/mcp-room-profile.mjs` | live |
| `workWakeSchema` | `store.mjs` | live |
| `ACTION_CLASSES`, `classifyCommand` | command validation paths (6 files for `surfaceClass`) | live |
| `SURFACE_CLASSES`, `surfaceClass`, `ACT_ONLY_EFFECTS` | `tests/action-classes.test.js` + server call sites | live |

## Notes

- `enqueue`/`requeue` have no HTTP route in `http.mjs` — they are reached
  via MCP/agent surfaces (`agent-plugin-routes.mjs`, `mcp-*`), not dead.
- The misplaced comment in `SURFACE_CLASSES` (see `07-action-classes.md`)
  is cosmetic, not dead code.
- Fuzz F7 found `enqueue()` accepts negative `dueAt` — live code with a
  validation gap, not dead code.
