# Dead code — server/store.mjs lines 1–1750

**None found in this range.** Spot checks (repo-wide grep):

- `StorageUnavailableError`, `isStorageUnavailable`, `STORAGE_FAILURE_THRESHOLD` — used by http.mjs readiness + routes.
- `PILOT_LIMITS`, `activeMemberCount`, `provisionalAccountPrefix` — referenced across server routes and tests.
- `COMMAND_TYPES` — exported for the action-class completeness test.
- `validateCommand` — used by the command path.
- `ensureDefaultChannelState`, `parseStoredJson`, `startColdStart`, `logColdStart` — used in the open path.
- `repairInvalidSupersessions`, `applyProvenanceRepair` — called at open.
- `nodeStorage` (configure/transaction/version/hasSchema) — the default storage platform.
- `ProjectionCache` — used by projection reads.
- `agentWakeTargets` / `agentWakeTargetIds` — used by wake paths.
- `ADDITIVE_SCHEMA_ENSURES`, `roomSchemaStamp`, `deepFreeze` — used in schema install/verify.

No unreachable branches identified in this range. (Full-file dead-code
verdict awaits the store-b and store-c workers.)
