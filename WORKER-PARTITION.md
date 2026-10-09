# WAVE-2000 Guild 33 — worker self-partition guide

Slice: **Docs — API cookbook + migration guides**, docs-only.
Branch: `wave2000/guild-33` (coordinator commits; workers do NOT commit).

## Your rules (k = your shard number, 1..50)

- Write ONLY under `worker-<k>/` (e.g. `worker-07/CLAIM-RENEW.md`). Never
  write outside your dir. Never `git commit`, `git push`, or open PRs.
- Topic: take the k-th entry in the shard table below (k=1 → shard 1, …).
- Format: one Markdown file per recipe/guide, with (1) goal, (2) endpoint or
  command, (3) copy-pasteable example (curl or Node `fetch` against the room
  API base `https://www.getdasha.com/room/api/rooms/muse-room` — or the local
  `scripts/room-coord.mjs` / `scripts/room` CLI), (4) exact error codes the
  reader will hit and what to do, (5) verification: how you checked it (code
  ref `server/<file>.mjs:<line>` and/or a targeted `node --test` file name).
- Docs-only: do not edit repo source, do not touch production, do not mint
  credentials, do not post to muse-room.
- When done, append ONE line to `guild.log`: `[<ts>] worker-<k> done: <file> (<topic>)`.

## Coordinator-owned (do NOT duplicate)

- `docs/cookbook/` core recipes (claim-task, post-events, read-boards,
  errors-retries) and `docs/cookbook/migrations/` (compare-and-release,
  renew-extend-from-now, identity-link) — coordinator writes these directly.
- Your files get integrated by the coordinator into `docs/cookbook/` later.

## Shard table (k → topic)

| k | Topic | k | Topic |
|---|---|---|---|
| 1 | Recipe: list work claims with filters (GET work-claims list) | 26 | Recipe: room-coord CLI — status/tail/digest reads |
| 2 | Recipe: read one work claim + history round | 27 | Recipe: BACKLOG.md via scripts/room backlog verbs |
| 3 | Recipe: claim a work item (advisory vs hard claim) | 28 | Recipe: MCP hosted tools for agents |
| 4 | Recipe: update a claim (notes, tags, evidence) | 29 | Recipe: agent-inbox reads |
| 5 | Recipe: renew a lease with progressMessageId | 30 | Recipe: room export (JSONL) + import round-trip |
| 6 | Recipe: release a claim (compare-and-release fields) | 31 | Migration: claim_renewal_source_* rules (422s) |
| 7 | Recipe: reassign a claim to another member | 32 | Migration: already_* 409 family (confirm-don't-retry) |
| 8 | Recipe: close/cancel a claim | 33 | Migration: claim_lease_lapsed recovery |
| 9 | Recipe: append a PR link (appendPullRequest) | 34 | Migration: work_not_owner 403 vs ownership checks |
| 10 | Recipe: read receipts for a claim | 35 | Migration: requestId idempotency contract |
| 11 | Recipe: post a room message (commands endpoint) | 36 | Recipe: curl quickstart (auth header, base URL) |
| 12 | Recipe: read the event log (events?after=&limit=) | 37 | Recipe: Node fetch client skeleton |
| 13 | Recipe: threads (read + reply) | 38 | Recipe: scripts/room-coord claim/renew/release |
| 14 | Recipe: pins (pin/unpin, read) | 39 | Recipe: scripts/room board verbs (claim/heartbeat/release) |
| 15 | Recipe: presence heartbeats | 40 | Recipe: replay-room-export for offline testing |
| 16 | Recipe: mint an agent identity (mcp-identity-mint) | 41 | Verify: spin a local server against fixture sqlite |
| 17 | Recipe: link identity to room (POST identity-links) | 42 | Verify: acceptance-fixture.mjs end-to-end claim flow |
| 18 | Recipe: guest invites (create/list/revoke) | 43 | Verify: export/import event-log round trip |
| 19 | Recipe: access requests (file/decide) | 44 | Verify: error-shape assertions (error.code/status/hint/next) |
| 20 | Recipe: check access (room_check_access pattern) | 45 | Verify: 429/503 retry-after client behavior |
| 21 | Recipe: error taxonomy walkthrough (ERROR-TAXONOMY.md) | 46 | Recipe: event-budget aware clients |
| 22 | Recipe: 409 conflict recovery playbook | 47 | Recipe: permission profiles (contribute/review/collaborate) |
| 23 | Recipe: stale_revision recovery (workContext re-read) | 48 | Recipe: spend-allowance read-only checks |
| 24 | Recipe: session_claimed recovery (wait vs supersede) | 49 | Recipe: notifications + DM consent reads |
| 25 | Recipe: reconcile after 503/timeout (never blind-replay) | 50 | Recipe: needs-attention + mentions triage |

Keep each file ≤ 120 lines. Cite `server/*.mjs` line numbers you actually
read. If your topic's endpoint no longer exists on origin/main, write a
`worker-<k>/NOTES.md` saying what replaced it instead of inventing it.
