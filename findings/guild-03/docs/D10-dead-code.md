# Guild-03 docs — D10: dead-code analysis (with reachability evidence)

Slice: `server/*routes*.mjs`, `server/mcp*.mjs`, `server/routes/`.
Method: every exported symbol in the slice was grepped repo-wide
(`server/`, `deploy/`, `scripts/`, `client/`, `src/`, `tests/`, docs —
excluding `.git`, `node_modules`, `findings/`). A symbol is reported dead
only with zero references outside its own declaration.

## CONFIRMED DEAD

### `roomMcpFetchPost` — server/mcp-http.mjs:217
`export async function roomMcpFetchPost(request, options = {})` — the
fetch-style POST handler for the MCP endpoint. Reachability: exactly one
match in the entire repo — its own declaration line. Nothing imports it,
nothing calls it:
- `deploy/room-entry.mjs` (the worker entry) uses `roomMcpFetchResponse`,
  not `roomMcpFetchPost`.
- `server/http.mjs` (node server) uses `writeRoomMcpNode`, not
  `roomMcpFetchPost`.
- No test references it.

It duplicates `writeRoomMcpNode`'s POST logic in fetch-`Request`/`Response`
form (parse JSON → `dispatchRoomMcp` → status via `mcpRpcStatus` +
`mcpAuthHeaders` + `legacyMcpHeaders`), presumably written for a worker
integration that never landed (the worker went with `roomMcpFetchResponse`
+ `writeRoomMcpNode` paths instead). ~45 lines. Safe to delete; no
behavioral change. (Per the working agreement: say what I deleted — I am
NOT deleting it; no PRs on this branch. Flagging for the merge queue.)

## UNWIRED BY DESIGN (not dead)

- `sweepFeedbackVerdicts` (server/feedback-routes.mjs:275): no production
  caller, but the module header documents it as "available but unscheduled
  — wire to a scheduler when the metrics dashboard slice lands
  (docs/feedback-endpoint.md §6)". Tested in tests/feedback-routes.test.js.
  Intentional.
- `handleSupervisionRoutes` (server/supervision-routes.mjs): not mounted in
  server/http.mjs — mounting explicitly DEFERRED to the integration lane
  (module header). Reachable via the documented future mount. Intentional.
- `createMatchmakingRegistry` / `handleMatchmakingCore`: the in-memory
  registry is the documented test seam ("the only one the tests need");
  production passes the store-owned registry. Intentional.

## ALIVE (spot-checked, non-obvious cases)

- `mcpJoinCorsHeaders`: no external importers, but used internally by all
  three MCP responders in mcp-http.mjs. Alive.
- `legacyMcpHeaders`: used internally by `roomMcpFetchPost` (dead) AND
  `writeRoomMcpNode` (live) — the export stays alive via the live path.
  (If `roomMcpFetchPost` is deleted, `legacyMcpHeaders` is still used.)
- `dispatchRoomMcp`: used by both live responders + tests. Alive.
- `createSubmitLimiter`, `LANE_RE`: used in-module + tests. Alive.
- `translateWith`, `requiredScope`, `createHeartbeatActor`
  (agent-plugin-routes): reused by `server/routes/table.mjs` (wake-status
  row) and other producers. Alive.
- `collabHttpError`: re-exported/used by http.mjs error translation. Alive.
- `isLegalPath`: used by http.mjs routing. Alive.
- `MCP_JOIN_TOOLS`, `livePublicMcpTools`, `listedMcpTools`,
  `liveEnrolledMcpTools`, `liveMcpServerCardJson`: used by mcp-http,
  mcp-room-profile, deploy/agent-discovery. Alive.
- `fileWarningsFor`, `createWorkClaimRegistry`, `mayWriteWorkClaims`,
  `buildWorkClaimPage`, `closeWorkClaim`, `linkWorkClaimPullRequest`:
  used by mcp-full-profile.mjs and http.mjs. Alive.
