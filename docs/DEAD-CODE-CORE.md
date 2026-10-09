# Dead code inventory — server core (WAVE-400 docs-core)

Every export in the 24-module partition was checked repo-wide (server/,
client/, cloudflare/, scripts/, src/, tests/) for callers.

## Verdict

- **Definitely dead: 0.** No unreachable exports, no dead branches found in
  any module.
- **Probably dead / needs owner confirm: 10 candidates.** All are exported
  names with no production caller. They may be intentional public API for
  external agents/tools — removal is a breaking change. **Re-grep the live
  tree before deleting anything**; sibling lanes may reference these in
  uncommitted work.

## Candidates

| # | Location | Name | Evidence |
|---|---|---|---|
| 1 | `server/work-claims.mjs:54` | `CLAIM_VERBS` | Zero internal uses; only `tests/claims-state-machine.property.test.js`. |
| 2 | `server/work-claims.mjs:40` | `REVIEW_VERDICTS` | Exported, no production callers. |
| 3 | `server/work-claims.mjs:39` | `CI_STATES` | Exported, no production callers. |
| 4 | `server/work-claims.mjs:980` | `workOwnedBy` | Exported, no production callers. |
| 5 | `server/work-claims.mjs:985` | `unclaimedWork` | Exported, no production callers. |
| 6 | `server/work-claims.mjs:66` | `DELIVERY_MODES` | Exported, no production callers. |
| 7 | `server/work-claims.mjs:287` | `DEFAULT_MAX_MEMBER_OPEN_CLAIMS` | Exported, no production callers. |
| 8 | `server/mcp-room-profile.mjs:101` | `identityBearer` | No importer anywhere; only used internally by `createHostedRoomMcp`. `http.mjs` imports only `createHostedRoomMcp`. |
| 9 | `server/room-lifecycle.mjs:24` | `ROOM_LIFECYCLE_MIGRATION` | Zero references anywhere in the tree. |
| 10 | `server/http.mjs:3357` | `human-push` legacy regex segment | No `route === "human-push"` dispatch branch exists; requests fall through to 405. Live surface is `server/routes/human-push.mjs` via the route table. |

Near-misses (live, kept): `work-claim-sqlite.mjs` `rawConfig` (duck-typed
callers in mirror + routes); `room-export` `exportNdjsonText` (primary test
helper); `room-aux` `COORDINATION_NORMS` (test-covered API);
`store.mjs` `issueAccessKey` (dev/test fixture callers only — production may
no longer issue operator keys this way).

## Per-module dead-code reports

Detail + caller evidence per module:
[docs/wave400-core/deadcode/](wave400-core/deadcode/).
