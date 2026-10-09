# room-directory-set — dead-code candidates (WAVE-400 code archaeology)

Method: for every export and every method in the three modules, grep'd
`server/` and `tests/` for importers/callers.

## Candidates

### 1. server/room-directory.mjs:166 — `RoomDirectory.receiptsVisibility(roomId, memberId)`

Dead in production. EVIDENCE:

- `grep -rn '\.receiptsVisibility(' server tests --include='*.mjs'` → zero hits.
- The owner settings PATCH route (server/http.mjs:4743–4761) covers the same need
  via `status()` after `setReceiptsVisibility()` — and `status()` already returns
  `publicReceipts`, so no route ever needed the dedicated getter.
- Only caller anywhere is `tests/room-directory.test.js:227,232,238` (coverage
  of owner-check/return-shape behavior).

Keep-or-remove note: it is a 6-line method with test coverage; harmless to keep as a
public API, but no production path exercises it today.

## Checked and NOT dead (all have production callers)

- `agent-rooms.mjs`: `roomCreateNext` → used in `create()` payload (also covered by
  agent-rooms tests); `AGENT_ROOM_LIMIT`/`AGENT_ROOM_CREATE_CAPACITY`/`AGENT_ROOM_CREATE_REFILL_PER_SECOND`
  → used in constructor + `create()`; `agentRoomSchema` → `server/store.mjs:83`;
  `AgentRooms.list/create/transfer` → `server/http.mjs` routes; `ROOM_TOKEN_NOT_IDENTITY`
  → `agent-rooms.mjs` + `server/http.mjs:3125`; second `new AgentRooms(store)` at
  `server/mcp-room-profile.mjs:931`.
- `public-rooms.mjs`: all eight exports used — `publicRoomView/templatesIndex/
  templatePage/agentDirectoryView/publicSitemapEntries/PUBLIC_PAGE_CSP` in
  `server/http.mjs`; `demoRoomView/PUBLIC_PAGE_CSP` in `server/routes/demo.mjs`;
  `publicRef` used internally for `?ref=` link building.
- `room-directory.mjs`: `roomDirectorySchema` + `RoomDirectory` → `server/store.mjs:54,1218`;
  `status/set/opportunityStatus/setOpportunities/setReceiptsVisibility/list` →
  `server/http.mjs`; `publicReceiptsVisible` → `server/http.mjs:1772`,
  `server/public-work-claims.mjs:290`; `ensurePublicReceiptsColumn` →
  `server/receipts-live.mjs:37` + internal `_ensureReceiptsColumn`;
  `DIRECTORY_PAGE_LIMIT/DIRECTORY_DEFAULT_LIMIT` → `list()` + test assertion.
