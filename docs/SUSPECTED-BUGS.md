# Suspected Bugs

Found 2026-10-09 during WAVE-400 docs/tooling archaeology (worktree `wave400/docs-tooling`,
base `origin/main@c5d1c313a`). Each is a code-vs-code or code-vs-intent contradiction with
line refs. None were fixed — docs/comments only. Filed to the room after this was written.

## Dead work-claim handlers (high confidence)

- `server/work-claim-routes.mjs` defines `close`, `cancel`, `provenance`, and `premise-invalid`
  handlers, but `server/http.mjs:3452-3465,3748-3762` never wires route regexes for them —
  all four 404 via HTTP. `close`/`cancel` are reachable via MCP (`room_close_work_claim`);
  `provenance` via MCP (`room_work_claim_provenance`); **`premise-invalid` is reachable from
  nowhere** — the practiced-rollback feature is dead code. The comment at http.mjs:3466-3468
  describes the intended regexes but they were never written.
- `server/http.mjs:3762` — the dispatch fallback `: "reassign"` would silently misroute any
  future regex added without a matching branch.

## Matchmaking lane registration dead (high confidence)

- `server/matchmaking-routes.mjs:41` — `putLane` is defined but never called by any route or
  code path, so `POST /matchmaking/decisions/{id}/answer` always 403s `lane_not_registered`.
  Lane registration has no HTTP surface.

## Supervision routes unmounted (high confidence)

- All 9 supervision routes in `server/supervision-routes.mjs` are defined but not mounted in
  `server/http.mjs` → every call 404s. Additionally `server/supervision-routes.mjs:223` — the
  `derive` route is labeled internal but nothing enforces it.

## Escrow HEAD reads 405 (medium)

- `server/http.mjs:3864` — `bountyListMatch ? (req.method === "GET" ? "list" : "create")` maps
  HEAD /bounties to escrowRoute "create", which 405s. HEAD on all read-only escrow routes
  (reviews, sybil-flags, reputation-reviews, balances, history) likewise 405s, despite the
  guest-scope gate at http.mjs:3697-3700 explicitly keeping HEAD reads open.

## MCP error reason rewritten (medium)

- `server/mcp-room-profile.mjs:870,877` — scoped-API-key inbox/wake denials call
  `mcpCallError(requestId, { reason: "insufficient_scope", ... })`, but `mcpCallError` in
  `server/mcp-arg-errors.mjs` only branches on `"auth_required"` and `"unknown_tool"`
  (mcp-arg-errors.mjs:148,168). The denial falls through to the default branch
  (mcp-arg-errors.mjs:192-211), which hardcodes `reason: "invalid_arguments"` with empty
  `missing`/`unexpected`/`invalid` — the intended `insufficient_scope` semantics are silently
  rewritten.

## MCP discovery unguarded lookup (medium)

- `server/mcp-discovery.mjs:40` — `CORE_MCP_TOOLS.map(name => hostedMcpToolDefs.find(entry =>
  entry.name === name))` then `entry.description` with no guard: one bad name in
  `CORE_MCP_TOOLS` throws TypeError and 500s every core `tools/list`. Unlike
  `HOSTED_ROOM_MCP_TOOLS`, no import-time drift check couples `CORE_MCP_TOOLS` to
  `hostedMcpToolDefs`.

## Agent-keys / identity routes

- `server/agent-plugin-routes.mjs:615` — `unverifyIdentity` issues no `rate()` call, unlike
  every other mutating route in the file (issueKey:207, keyAction:269, verifyIdentity:606,
  rotateIdentitySecret:660, revokeIdentitySecret:681) — a destructive owner action with no
  rate limit.

## Script issues

- `scripts/backup-room.mjs:8-13` — the catch-all maps a missing-args usage error to
  "Backup failed verification. Live data was not replaced." (exit 1), the same message as a
  real verification failure. An operator reading the log cannot distinguish "you forgot --to"
  from "the backup is corrupt".
- `scripts/disk-door.mjs:76-89` — a crash between the per-entry `saveState` in the relay loop
  and the final `saveState` (after `appendFileSync`) replays `roomMessages` from the stale
  `state.seq` on the next run, appending duplicate room→channel lines. Room→channel writes are
  not deduped the way channel→room writes are (scripts/disk-door.mjs:34).
- `plugins/project-room/channel/serve.mjs:38` — `await main()` passes no `--mode channel`;
  a host that spawns serve.mjs without `--mode` gets `usage_error`
  (scripts/room-listen.mjs:10 requires `argv[0] === '--mode'`). Only
  `agent-claude-channel.mjs` reliably preselects the mode.
