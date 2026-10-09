# Dead-code candidates — server/mcp-room-profile.mjs

Method: read the full 951-line file, then grepped for every exported symbol's importers/callers
across `server/`, `src/`, `client/`, and `tests/`. Every internal function and every import is
referenced at least once inside the file except the one case below.

## Probably dead / needs owner confirm

- **`identityBearer` (exported, line 101)** — No importer anywhere in the repo. Only caller is
  `createHostedRoomMcp` internally (line ~940). `grep -rn "identityBearer"` across `server/`,
  `src/`, `client/`, `tests/` finds only OpenAPI security-scheme strings in
  `server/discoverability.mjs` (unrelated — that's a securityScheme name) and the definition/call
  inside this file. Not referenced by `server/mcp-http.mjs` or `server/http.mjs`.
  EVIDENCE: `grep -rn "from \"./mcp-room-profile.mjs\""` shows the only importer of this module is
  `server/http.mjs` importing just `createHostedRoomMcp`.
  VERDICT: probably dead as a public export — but kept as "needs owner confirm" because it's exported
  and could be part of an intended public helper API (e.g. reused by future auth code); safe to
  un-export rather than delete.

## Checked and NOT dead

- All imports (30+): every one is used — `MCP_DISCOVERY_BLOCK`, `ServiceError`, `isIdentitySecret`,
  `API_KEY_PREFIX`, `enforceAutonomyTierForAction`, `HeartbeatError`, `AgentPluginError`,
  `EVENT_CATALOG`, `WebhookSubscriptionError`, `BOND_SCOPES`, `EscrowError`, `buildActivationPack`,
  `buildOrient`, `walkProvenance`/`ClaimError`, `randomUUID`, `validId`/`ROOM_KINDS`/
  `MAX_MESSAGE_BODY_CHARS`, `nextWorkStep`, `completedResults`/`searchWork`, `sortWorkByCuriosity`/
  `viewerHistory`, `workHelpContext`, `HOSTED_ROOM_MCP_TOOLS`/`HOSTED_MCP_FOLLOW_UPS`/
  `ROOM_MCP_SERVER_NAME`/`ROOM_MCP_SERVER_VERSION`/`canonicalMcpToolName`, `MCP_JOIN_TOOLS`/
  `MCP_AUTH_REQUIRED`/`handleMcpJoinRpc`, `mcpInvalidRequest`, `AgentRooms`, `AccessRequests`,
  `collectNeedsMe`, `MCP_SUPPORTED_VERSIONS`/`MCP_VERSION`, `isHostedStdioTool`/
  `validHostedStdioArgs`/`callHostedStdioTool`, `friendBondCommand`, `validAttachmentData`,
  `closestToolName`/`diagnoseArguments`/`mcpCallError`, `chargeSpendBeforeCall`, `ROOM_TOOLS`/
  `INBOX_TOOLS`/`WAKE_TOOLS`/`HOSTED_TOOLS`, `listedMcpTools`/`MCP_TOOL_FOCUSES`, `stampEvents`/
  `stampWorkListing`, `redactEventPage`, `resolveCatalogAgent`/`catalogCallDenial`, squad helpers.
- All module-private functions are called: `rpcError`, `toolResult`, `failureValue`,
  `validPermissionList`, `allowed`, `validScopes`, `validThreadId`, `validRoomArgs`, `validInboxArgs`,
  `validHostId`, `validCadence`, `validUrlString`, `validPush`, `validEvents`, `validSignalIds`,
  `validWakeArgs`, `workRecord`, `listWork`, `enforceMcpCallVisibility`, `callLandTool`, `callRoomTool`,
  `dispatchRoomToolCall`, `callInboxTool`, `commandReceipt`, `listPeerDms`, `heartbeatReceipt`,
  `webhookListBody`, `webhookSubscribeBody`, `wakeFailure`, `callWakeTool`, `argumentFailure`,
  `queryFlag`, `listSelection`, `handleAuthed`, `mcpKeyGrantsScope`, `mcpRoomAllowlist`,
  `resolveMcpIdentity`.
- `createHostedRoomMcp` (exported, line 930) is imported by `server/http.mjs` — live.
- Every one of the 38 room tools has a matching branch in both `validRoomArgs` and
  `dispatchRoomToolCall` (verified by name-by-name comparison; the final `throw` is unreachable by
  construction).
- `ID_KEYS` contains `workItemId` though no tool in this file takes it — harmless generic list for the
  invalid-id diagnostic, not dead code.
