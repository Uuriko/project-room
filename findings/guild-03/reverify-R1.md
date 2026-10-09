# re-verify R1: wave300/data-plane-fastpath
started: 2026-10-09T09:08:06Z
HEAD is now at 18f6fc13d feat: fast path tests (6/6) + allow fast in BOARD_QUERY
branch head: 18f6fc13d, merge-base with origin/main: a21c2364
slice files changed: server/mcp-full-profile.mjs server/work-claim-routes.mjs 
rebase: CLEAN onto a6af5f2ac
running affected suite: tests/work-claims-read.test.js tests/work-claim-sweep.test.js tests/mcp-room-messages-paging.test.js
suite: 3 passed, 0 failed
node --check on slice files:
done: 2026-10-09T09:10:34Z

## adversarial review (guild-03)
Rebase: CLEAN. Suite: 3/3 pass. node --check clean.

FINDING R1-1 (dead parameter, low): `dispatchHostedStdioTool` reads
`fast: rest.fast === true` for room_close_work_claim and
room_link_work_claim_pr, but neither tool's inputSchema declares `fast`
(client/mcp-stdio.mjs, additionalProperties:false). The MCP tools/call
argument validator rejects unknown properties, so the MCP fast flag is
unreachable — only HTTP ?fast=1 works. Either declare `fast` in both
schemas or drop the dispatcher lines.

FINDING R1-2 (semantic hazard, advisory): fast-path commit() skips
emitWorkClaimEvent AND enqueueClaimWake/noteReadyWork/wakeNamedReviewers.
Fast writes are invisible to wake subscribers and the BOARD-WAKE-2 ready-work
feed. Documented as intended ("events are just notifications"), but any
consumer relying on wakes sees inconsistent delivery when fast and slow
writes mix in one room.

FINDING R1-3 (liveness question, advisory): fast reads skip sweepRoom and
closeLiveClaims ("expiry is owned by the server-side reaper tick"). If no
reaper tick is actually scheduled, expired leases on fast-only rooms never
release. Verify the reaper exists before this merges.

FINDING R1-4 (backpressure bypass, advisory): requireEventBudget is a no-op
on fast path. Coherent (no events emitted) but removes the Q3-A 409
backpressure for fast writers; registry caps (maxOpenClaims) remain the only
write throttle.
