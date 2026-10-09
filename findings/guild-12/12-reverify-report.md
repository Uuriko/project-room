# Re-verify report: wave300-fanout-perf on current origin/main (guild-12)

## R1 — branch audit

`wave300-fanout-perf` = 5 commits on top of origin/main:

| Commit | Change | Slice relevance |
|---|---|---|
| `d6e1daf72` F1 | shared SSE pump per room — `server/http.mjs` `stream()` rewritten (210 lines) | **direct**: the SSE delivery path of this slice |
| `05745b7e5` F2 | bounded-parallel wake dispatch + coalescing — `server/agent-plugin-store.mjs` | adjacent: webhook wake-ping delivery |
| `7d77c39b9` F4 | sequence-keyed projection cache | indirect (read path) |
| `9b43f6e14` F3 | boardSeq hardening + `includeInvisible` store option for the shared pump | supporting F1 |
| `dc96606ac` | design doc | — |

My slice files (`server/wake-queue*.mjs`, `server/work-wakes.mjs`,
`server/action-classes.mjs`) are **not modified** by the branch.

## R2 — rebase

Scratch branch `wave1000/guild-12-fanout-scratch` rebased onto
`origin/main` (`2eda65ff2`): **5/5 applied cleanly, zero conflicts**
(log `logs/R2-rebase.log`). The branch is recent and conflict-free.

## R3/R4 — affected suites on the rebased tree

- Wake suite (10 files: wake-queue, agent-wake, agent-wake-poll, board-wake,
  board-wake-ready-work, room-mcp-wake, pull-only-heartbeat-wakes,
  wake-path, wake-pause, action-classes): **91/91 pass**.
- Stream suite (8 files: stream-lifecycle, stream-backpressure,
  stream-recovery, stream-interval, stream-shared-pump, sse-sequenceof,
  client-stream, private-history-stream): **29/29 pass**.

## R5 — branch's own tests on the rebased tree

`webhook-dispatch-parallel.test.js`, `work-claim-board-seq.test.js`,
`f4-projection-cache-isolation.test.js`: **13/14 pass, 1 FAIL**
(log `logs/R5-branch-tests.log`).

**Breakage found:** `work-claim-board-seq.test.js` →
"boardSeq starts at 0 and increments exactly once per mutation" fails with
`422 invalid_claim_input` — `Expected {expectedClaimedAt,
expectedHistoryLength, reason?, note?}` at `work-claim-routes.mjs:130`.
The branch's test (new file, added by the F3 commit) calls
`release`/`update`/`renew` with `{}` bodies. The branch was cut at
`cb05aa5bf`, before #2088 landed on main; #2088 made
`expectedClaimedAt`/`expectedHistoryLength` **required** (deliberate
breaking change, all in-repo callers migrated). The rebased branch was not
migrated. Fix for the branch owner: read the claim's `claimedAt`/`history`
in the test and pass them as `expectedClaimedAt`/`expectedHistoryLength`.
Not slice code, but a real rebase breakage — reported here per the
re-verify mandate.

## R6 — the 34x claim, reproduced

Bench `tests/bench-fanout-f1.mjs` (SIM: fake store, real `http.mjs`),
100 streams × 10s × 250ms pump, full 100-row pages:

| | before (origin/main http.mjs) | after (rebased F1) |
|---|---|---|
| `eventsAfter` calls | 1396 | 27 |
| ratio | — | **~52x fewer** |
| CPU burn | 137.2 ms/s | 105.4 ms/s (−23%) |
| event-loop mean delay | 107.96 ms | 21.87 ms |
| event-loop p99 delay | 1037 ms | 478 ms |

The design doc claims 1028 → 30 (~34x). My independent run: **1396 → 27
(~52x)** — the claim verifies on rebase and is, if anything, conservative.
Same machine, same args, both directions.

## R7 — adversarial review: F1 shared pump (`server/http.mjs`)

- Wire protocol unchanged: same framing, same `stream_lagging` /
  `access-ended` / `unavailable` events, same heartbeats, typing without id.
- Security-critical piece: the shared fetch rides the *leading* stream's
  credential with `{ includeInvisible: true }`, then `filterPageForViewer`
  narrows per stream. Correctness hinges on the filter mirroring
  `store.eventsAfter`'s visibility rules exactly (DM follow-ups, PRIV-2
  history floor, peer-private). Covered by `stream-shared-pump.test.js`
  (green on rebase); filter drift is the thing to watch in future diffs.
- Per-tick per-stream `store.authenticate` — a revoked credential ends only
  that stream (strictly better isolation than before).
- Cursor: `max(entry.cursor, page.next)` — a stream ahead of the shared
  window waits; no gaps, no dupes beyond the in-flight batch.
- Timer lifecycle: one interval per room, cleared when the last stream
  leaves; `pumpRoom` also reaps destroyed sockets per tick. No leak path
  found.
- **Tradeoff (not a bug):** one far-behind stream drags the shared page
  window — head streams wait for the window to catch up (head-of-line
  across cursors). Latency-sensitive consumers should keep cursors fresh.

## R8 — adversarial review: F2 parallel wake dispatch

- Bounded pool (`WEBHOOK_DRAIN_CONCURRENCY = 8`); the only await is the
  network POST; DB mutations stay in synchronous `mutate()` callbacks —
  per-delivery transaction semantics identical to the sequential loop.
- Coalescing: same URL + same eventId → one POST, followers marked
  delivered with the leader's envelope. Sound for receipt-idempotent pings.
- **Latent nit:** `wakeCoalesceKey` = `` `${url}${row.event_id}` `` with no
  separator. Practically untriggerable (eventIds are UUIDs), but a crafted
  URL pair could collide and silently mark a delivery delivered without its
  subscriber receiving the ping. `JSON.stringify([url, eventId])` would
  remove the class.

## R9 — methodology assessment of the 34x claim

- The bench is labeled SIM and is honest about it: the store is faked
  (SQLite query cost excluded), but the **real** `http.mjs` pump code runs,
  including the new per-stream `filterPageForViewer` — so the after-number
  includes the filter cost the claim could have hidden.
- `monitorEventLoopDelay`'s floor on this VM is ~1000ms/s even idle, so the
  delay histogram can't discriminate; the `cpuUsage`-based burn number is
  the meaningful one (−23%).
- The 34x counts `eventsAfter` calls, not end-to-end latency. Under the SIM
  it holds; production proof needs the telemetry the branch's F4 lays.

## Verdict

**One rebase breakage** (branch's own F3 test vs #2088's required fields —
fix documented above); otherwise clean: rebase conflict-free, all 120
affected tests green, 34x claim reproduced independently (~52x in my run).
Two notes for the branch owner: head-of-line cursor tradeoff (documented)
and the coalescing-key separator nit. The breakage needs the branch
owner's migration, not mine (not slice code).
