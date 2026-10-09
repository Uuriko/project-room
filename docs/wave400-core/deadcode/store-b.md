# Dead code — server/store.mjs lines 1751–3500

**None found in this range.** Verified by repo-wide grep (including tests):

- `runDeferredIntegrityBatch` / `backfillReferralDepth` — called internally
  (`store.mjs:2023,2030,2055` and `:1881`); also test-covered.
- `authenticateAccountAccessKey`, `rotateAccountSessionSlot` — test-covered;
  production callers via the auth paths.
- All `migrate*` methods — called from the open/migration flow.
- Invitation methods (`issueInvitation`, `acceptInvitation`,
  `revokeInvitation`, `previewInvitation`, `invitationStats`) — called from
  HTTP routes.
- Account methods — called from account routes and OAuth flows.
- `historyFloor`, `ensureEventTypeIndex`, `close`, `transaction`,
  `readTransaction`, `room`, `rebuildProjection`, `storedProjection` — core
  paths.

No unreachable branches identified in this range. (Full-file verdict awaits
the store-a/store-c workers; store-c reported no dead code.)
