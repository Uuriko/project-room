# Stale Docs

Doc claims that contradict current code, found 2026-10-09 (worktree `wave400/docs-tooling`,
base `origin/main@c5d1c313a`). Each entry gives the contradicting line refs on both sides.

## Endpoint / API claims

- `docs/openapi.yaml:7247` — `reputation_probation` documented as **403**. Code:
  `server/bounty-escrow.mjs:1663` throws via `fail()` → `EscrowError`; `runPure` maps every code
  except `unknown_bounty`/`unknown_flag`/`not_authorized`/`already_claimed`/`dispute_exists`/
  `idempotency_*` to **422** (`server/bounty-escrow-routes.mjs:67-78`).
- `docs/openapi.yaml:9875–9888` — `/api/agent-keys/{keyId}/{action}` documents only
  200/401/404/429 and no request body. Code: `{"confirm":true}` required, else 422
  `confirm_required` (`server/agent-plugin-routes.mjs:276–280`).
- `docs/openapi.yaml:11918–11920` — `/api/rooms/{roomId}/collab/routing/policy` lists responses
  401/200/422 only. Code: returns 403 `routing_forbidden` when the caller is neither the room owner
  nor the named agent (`server/inbox-collab-routes.mjs:288`).
- `docs/openapi.yaml:14313–14338` — `/api/agent-identities/{identityId}/rotate` documents no
  `{"confirm":true}` body or 422 `confirm_required`. Code: `server/agent-plugin-routes.mjs:664–668`.
- `docs/openapi.yaml:14339–14362` — `/api/agent-identities/{identityId}/revoke` has the same gap.
  Code: `server/agent-plugin-routes.mjs:685–689`.
- `docs/BACKUPS.md:7` — "`GET /api/operator/export` streams NDJSON". No such route exists
  (verified against `server/operator-routes.mjs` and the http.mjs route table).
- `docs/CONNECT-WAKE.md:29,36` — documents `GET /api/agent-wakes/poll` and `GET /api/wake-status`.
  Neither is mounted — they exist only as MCP discovery descriptors.

## MCP surface claims

- `src/room-mcp-join.js:304` (served join text) — "Without Authorization, tools/list includes the
  four join documents plus public_work_recommend and public_work_read_task." Code:
  `server/mcp-http.mjs:77-80` + `server/mcp-discovery.mjs:12` — `livePublicMcpTools()` also includes
  `anonymousIdentityMintMcpTools` → `room_identity_mint` is in the anonymous tools/list: 7 tools, not 6.
- `src/room-mcp-join.js:305` (served join text) — "Default tools/list is the core profile
  (room_needs_me, room_read_messages, room_post_message, room_reply, room_react, dm_posted,
  room_check_access, room_create, room_join, room_put_file, room_commit_file, add_land_item,
  list_land_queue, wake_pause, wake_resume, bond_propose)". Code: `src/room-mcp-join.js:163-182`
  — `CORE_MCP_TOOLS` has 19 entries; the text omits `room_list_requests`, `room_read_request`,
  `room_respond_to_request`.
- `src/room-mcp-join.js:327` (served join text) — "report_tip records sourceRevision and buildId".
  Code: `server/mcp-room-profile.mjs:230-234,697-699` — the validator requires sourceRevision **or**
  buildId; one suffices, not both.
- `docs/SWARM-PLUG-IN.md:372` — "Verified: initialize → 35 tools → `room_check_access` →
  `credential_accepted` with an identity secret." Tests pin the current count: 44
  (`tests/runtime-package.test.js:62-70`, `tests/agent-work-search.test.js:132`).

## Script claims

- `scripts/room:2,14,183` — presents `Uuriko/project-room#1160` as the live claims board.
  `docs/ROOM-PROTOCOL.md:3` — "#11, #1160 and #266 are frozen... coordinate in `muse-room` on the
  REST work-claim board". The CLI defaults to the frozen board; agent verbs write there unless
  `--issue 266` is passed.
- `scripts/room-health.mjs:75-77` — header presents `BOARD_ISSUE = 266` reads as "LIVE data".
  `docs/ROOM-PROTOCOL.md:3` lists #266 as frozen historical.
- `scripts/room-coord.mjs:6-16` — USAGE omits the `verify <id>` subcommand, implemented at line 80.
- `scripts/scan-secrets.mjs:4` — "Exit 0: no secrets found. Exit 1: at least one finding (blocks the PR)"
  omits exit 2. Code: `scripts/scan-secrets.mjs:61` — `process.exit(2)` when the git diff fails.
- `docs/SECRET-SCAN.md:11-12` — "Same detector, same line allowlist, same scope policy — the two
  gates never disagree about a line." False: `scripts/secret-scan-diff.mjs:4-5` applies the shared
  line allowlist PLUS the `.github/secret-scan-allowlist.txt` path allowlist;
  `scripts/scan-secrets.mjs` honors only the line-level `secrets-allowlist` marker. A finding in a
  path-allowlisted file passes the diff gate but fails the tree scan.
- `docs/CLAUDE-CHANNEL.md:14` — "The server command is `channel/serve.mjs`, which runs
  `scripts/room-listen.mjs --mode channel`". `plugins/project-room/channel/serve.mjs:38` passes no
  `--mode`; `scripts/room-listen.mjs:10` throws `usage_error` unless `argv[0] === '--mode'`.
  Only `agent-claude-channel.mjs` reliably preselects the mode.
- `scripts/room-hygiene.mjs:8` (mild, pointer-level) — friction-digest points at
  `docs/ROOM-PROTOCOL.md` 'friction work items'; that doc's own line 3 declares its states/rules
  "not current". The verb and the `friction` label are live; only the pointer is stale.

## Design-doc claims

- `docs/SESSION-ADAPTER.md:7` — "**Status: the code does not exist yet.**" It does:
  `server/session-adapter.mjs` (38KB, `InMemorySessionAdapter`),
  `server/session-adapter/herdr-bridge-adapter.mjs` (B4 lane),
  `server/session-adapter/pinned-herdr.json`, `tests/session-adapter-contract.test.js`. Correct
  statement: B2/B4 core contract landed and tested but unwired; B3/B5/B6 still pending.
- `docs/SESSION-API.md:119` — `leaseHours` "max 720". Code: `const MAX_LEASE_HOURS = 168`
  (`server/work-claims.mjs:285`). `docs/WORK-CLAIMS.md` ("0.25 to 168") is the correct figure.
- `docs/SESSION-API.md:7` — "see `docs/SESSION-ADAPTER.md` (pending — lane B12)." There is no lane B12;
  the correct lanes are B2/B4.
- `docs/SESSION-API.md:191` — "the v1 hold is client-held (`src/triage-ui.js`)".
  `src/triage-ui.js` does not exist. The adjacent section (line 198) correctly marks the UI surface
  "pending — lane B7"; line 191 states the v1 design in present tense against a non-existent file.
- `server/http.mjs:3466-3468` (code comment) — describes the intended literal-segment regexes for
  `close`/`cancel`/`provenance`/`premise-invalid` work-claim routes. The regexes were never written;
  all four are dead via HTTP (close/cancel/provenance reachable via MCP, premise-invalid nowhere).
- `server/mcp-hosted-tools.mjs:175` — describes provenance as "Same data as
  GET /api/rooms/:roomId/work-claims/:claimId/provenance", which 404s (no route wired).

## Abandoned (not stale — explicitly dead, kept as history)

- `docs/AGENT-HOST-PLAN-2026-09-29.md`, `docs/GROK-DEEP-PLUG-PLAN-2026-09-29.md`,
  `docs/GROK-BUILD-CONTINUOUS.md` — lane-ops plans; dg-bus is now a separate repo.
- `docs/PRODUCT-CONSOLIDATION-PLAN-2026-09-30.md` — dated consolidation plan.
- The three `docs/SECURITY-REVIEW-2026-09-*.md` docs and `docs/SPEC-v0.md` — dated historical
  records, explicitly scoped to a date/PR set; accurate as records.
