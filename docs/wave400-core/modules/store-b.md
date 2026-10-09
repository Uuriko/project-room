# server/store.mjs — part B (lines 1751–3500): integrity, transactions, accounts, invitations

`RoomStore` methods, continued from part A. This range covers: deferred
integrity batches, schema stamps, projection repair/replay, transaction
wrappers, storage-failure accounting, room open/rehydrate, the account system
(create/authenticate/sessions/OAuth), and the invitation lifecycle.

## Method groups in this range

- **Integrity** (`runDeferredIntegrityBatch`, `verifyRoomIntegrity`,
  `incrementalIntegrityCheck`, `integrityChecksum`, `ensureIntegrityRoomState`,
  `repairProjectionProvenance`, `replayProvenance`, `roomsNeedingProvenanceReplay`,
  `repairProjectionShape`, `verifyHelpHistory`, `helpProjectionPresent`):
  the constructor used to run these eagerly; now they run in budgeted batches
  per cron tick from a stored cursor, so a hibernated wake doesn't restart at
  share links. `integrityChecksum` / snapshots let later ticks skip work.
- **Schema stamps** (`schemaStampMatches`, `rememberSchemaStamp`,
  `coldStartExtra`): `room_schema_stamp` records the exact schema text hash;
  mismatch triggers repair paths.
- **Messages parity** (`backfillMessages`, `checkMessagesParity`): thin
  wrappers over `messages-store.mjs`.
- **Transactions** (`transaction`, `readTransaction`): delegate to the
  storage platform; `storageFailure` / `storageRecovered` / `storageStatus`
  maintain the consecutive-failure counter that trips 503 readiness.
- **Room open** (`room`, `roomAuthority`, `rebuildProjection`, `_replayRoom`,
  `rehydrateAllProjections`, `storedProjection`, `_restoreBodiesFromLog`,
  `initialize`): event-log → projection rebuild; bodies-at-rest restore.
- **Accounts** (`account`, `createAccount`, `accountProfile`,
  `updateAccountProfile`, `onboardingState`, `completeOnboarding`,
  `issueAccountAccessKey`, `authenticateAccountAccessKey`,
  `revokeAccountCredential`, `revokeStaleAccountKeys`,
  `revokeUnverifiedPasswordSessions`, `invalidateHumanAccountCredentials`,
  `createAccountSessionSlot`, `accountSessionSlot`, `loginAccountSession*`,
  `rotateAccountSessionSlot`, `logoutAccountSession`,
  `authenticateAccountSession`, `accountRooms`, `createAccountRoom`,
  `ensureHumanAccountBinding`, `bindHumanAccount`, `markAccountHadRoom`,
  `sessionOwnership`, `changeAccountAccess`, `issueAccessKey`, `mintAccessKey`):
  human account provisioning, access-key issuance with 7-day default lifetime,
  session slots (30-day), OAuth pending-state (create/get/consume/delete),
  Google login, and room↔account binding.
- **Invitations** (`issueInvitation`, `previewInvitation`, `invitationStats`,
  `revokeInvitation`, `acceptInvitation`, `authenticateInvitationAdmin`,
  `verifyInvitationRecord`, `verifyInvitationAudit`, `verifyInvitedMembership`,
  `appendInvitationJournal`, `staleMembers`): the invite lifecycle with a
  journal; `migrateInvitation*` / `migrateAgentIdentitiesV27` /
  `migrateShareLinkAgentIssuerV35` / `migrateInvitationAgentRevokeV36` /
  `migrateIdentityV3` converge old databases.
- **Misc**: `historyFloor` (PRIV-2), `ensureEventTypeIndex`, `close`,
  `_dropProjectionCache`, `_armProjectionWatch`.

## Invariants

- Deferred integrity steps are the same checks the constructor used to run —
  the cursor only changes *when*, not *what*.
- Access-key lifetimes default to 7 days; session slots to 30 days.
- Invitation acceptance is journaled; the journal replays deterministically.

## Gotchas

- `runDeferredIntegrityBatch` is async but each step is sync; `yieldBetween`
  lets a tick shed load.
- `staleMembers` defaults to a 30-day window — callers must pass `now` in
  tests or it reads the wall clock.
- Migration methods are one-way; they assume the version they migrate from
  and fail closed otherwise.

## Stale comments

None found in this range — migration comments name the versions they
converge, and the deferred-integrity comments describe the cursor correctly.
