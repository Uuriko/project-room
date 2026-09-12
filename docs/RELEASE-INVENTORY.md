# Release inventory (B1)

September 12, 2026. One current record of what exists and how well it is known,
so stale historical plans cannot be mistaken for current availability. Older
checkpoint and research documents (including the Sep-8 backlog's "where we are"
table) are historical; when they disagree with this file, this file wins until
the next inventory supersedes it.

Statuses: **local** (works on this checkout), **qualified** (local plus
executable CI evidence on main), **live** (verified serving on a deployed
worker), **unknown** (not verified recently enough to claim).

## Runtime baseline

| Fact | Value | Source |
|---|---|---|
| Baseline commit | `1a24ad1` (main, Sep 12 2026) | git |
| Schema / writer version | 27 | `server/writer-fence.mjs` `SCHEMA_VERSION` |
| Node floor | >=24.19.0 | `package.json` engines |
| Contract suite | `npm run check`, 138 test files, green on main | `tests/`, CI |
| Browser gates | `npm run test:browser`, 47 scripted checks, green on main | `package.json`, CI |
| Worker packaging | runtime-package exact allowlist + import-closure gate, green | `tests/runtime-package.test.js` |

## Capability inventory

| Capability | Status | Evidence |
|---|---|---|
| Accounts, invitations, anyone-with-link guests | qualified | tests/invitations*, share-links, account-rooms; browser invitation checks |
| Durable conversation, threads, edit/delete | qualified | tests/conversation, message-thread, message-edit-delete |
| Work ownership, scope claims, blockers, evidence, review, owner decisions | qualified | tests/work-*, claim-scopes, handoff-receipt |
| Explicit reply requests and request attention | qualified | tests/reply-requests, request-attention, reply-request-browser-check |
| Managed agent identities, enrollment, one-time invite codes | qualified | tests/agent-identities, agent-enrollment, agent-invites (PR #126) |
| Connection doctor (read-only self-check) | qualified | scripts/agent-doctor.mjs, tests/agent-doctor (PR #125) |
| Agent access over HTTP API, CLI, local MCP stdio | qualified | tests/mcp-stdio, mcp-lifecycle, mcp-integration, scripts/agent-inbox.mjs |
| Portable task packets and manual result return | qualified | tests/portable-work, return-brief; browser portable-work check |
| Scoped discussion reads, current-attention journals | qualified | tests/current-attention*, attention-read-budget |
| Work search, board projection, room results | qualified | tests/work-search, board-projection, room-results |
| Import/export, recovery, schema upgrades | qualified | tests/recovery*, room-export, agent-upgrade, writer-fence |
| Release evidence manifest, journey coverage map | qualified | scripts/release-evidence.mjs, scripts/journey-coverage.mjs |
| Hosted deployment (worker serving the current build) | **unknown** | Last recorded live: fb90a70 / Worker 901be347 / schema 7 (Sep 8 research). Not reverified since; B7/B8 gate any live claim |
| Hosted AI execution, remote OAuth MCP, execution runner | not delivered | no implementation on main |
| Money movement (funding, payout, refunds) | not delivered | externally gated (backlog section J) |

## Rules

1. A capability not listed here, or listed as unknown, is not available - no
   matter what an older plan or README line says.
2. "Live" requires a fresh served-bytes check against the deployed worker;
   CI green alone never establishes live.
3. Update this file in the same commit that changes any row.
