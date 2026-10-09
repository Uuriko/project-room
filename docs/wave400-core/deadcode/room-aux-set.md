# Dead-code candidates — room-aux-set (WAVE-400 code archaeology)

Scope: `server/room-activation-pack.mjs`, `server/room-assistant.mjs`,
`server/room-key-presence.mjs`, `server/room-flood-guard.mjs` at
`wave400/docs-core` (origin/main `c5d1c313a`).

## Verdict: none found

Every export of the four modules has at least one live production caller or is
wired into the schema/route table. Evidence from grep over `server/`, `src/`,
`tests/`, `client/` (excluding `node_modules`):

| Export | Callers / evidence |
|---|---|
| `buildActivationPack` (room-activation-pack) | `server/http.mjs:4019` (`GET /api/rooms/:slug/activation-pack`), `server/mcp-room-profile.mjs:493` (MCP `room_activation_pack`) |
| `COORDINATION_NORMS` (room-activation-pack) | Imported only in `tests/room-activation-pack.test.js` — but it is part of the module's documented public API and its shape is asserted by tests; not production-dead, test-covered contract |
| `roomAssistantSchema` (room-assistant) | `server/store.mjs:60` (import), `server/store.mjs:1059` + `:1736` (executed in schema bundle) |
| `RoomAssistant` (room-assistant) | `server/routes/room-assistant.mjs:29` (`/api/rooms/{roomId}/assistant` GET/POST), `server/mcp-full-profile.mjs:199` (MCP assistant tools), `server/routes/table.mjs:10` (route wiring) |
| `roomKeyPresenceAuth` (room-key-presence) | `server/agent-plugin-routes.mjs:101` |
| `assertRoomKeyPullOnly` (room-key-presence) | `server/agent-plugin-routes.mjs:791,805,807` |
| `roomKeyHostId` (room-key-presence) | `server/agent-plugin-routes.mjs:806,889` |
| `roomKeyPresenceView` (room-key-presence) | `server/agent-plugin-routes.mjs:842` |
| `createRoomFloodGuard` (room-flood-guard) | `server/store.mjs:22` (import), `server/store.mjs:1179` (construction), `server/store.mjs:4574` (consume call site) |

Near-misses checked and cleared:
- `pack.orient` (activation pack line ~170) is set but never read by any
  server/client code found — it is a *response field*, not dead code; removing
  it would change the API. (Documented as an undocumented-field gotcha in the
  modules doc.)
- `COORDINATION_NORMS` has no production importer, but it is intentionally
  part of the pack payload (`coordinationNorms: { ...COORDINATION_NORMS }` is
  used in-repo) and its frozen-ness is test-guarded. Not dead.
- The `list()` "fresh installation" early-return branch and the
  `deletedControl` stubs in room-assistant are live paths exercised by tests
  for new rooms and deleted-source messages.
