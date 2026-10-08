# Dead code — work-claim-routes.mjs lines 1–680

Method: grepped every defined function/const/export in lines 1–680 for callers
across the repo (`.mjs`/`.js`, excluding node_modules), then verified each hit
is a real use (same-file use in lines 681–1355 counts — those are the route
handlers this range supports).

## Definitely dead

None found.

## Probably dead / needs owner confirm

None found. Every candidate below was checked and has a live use:

| Symbol (def line) | Evidence it is live |
|---|---|
| `createWorkClaimRegistry` (68), `workClaimRegistry` (106) | `handleWorkClaims` falls back to `defaultRegistry` (588); exported for tests/fixtures |
| `fileWarningsFor` (96) | called in the update route (1024) |
| `shape` (109), `invalidInput` (116), `claimIdOf` (118) | used across both halves (592, 966, 1028…) |
| `leaseHoursOfBody` (128) | W1 null-preservation helper, used on create path |
| `summarizeBoardClaim` (149) | used in `buildWorkClaimPage` view=summary (358) |
| `resolveWorkClaimAccess` (161), `mayWriteWorkClaims` (186) | used in 609, 624, core routes |
| `mayReviewWorkClaims` (197), `reviewersOf` (202) | used at 1117, 1067 |
| `mayManageAnyClaim` (207), `mayOptOutOfLease` (214) | used at 763, 519+ |
| `mayAttestWorkClaims` (221), `refuseAttest` (244) | used at 1131 |
| `maySweepWorkClaims` (232), `refuseSweep` (247) | used at 624–628 |
| `refuseBoardAction` (236), `refuseWorkClaims` (251), `refuseCap` (265) | used throughout core (913, 939, 985, 1204) |
| `boardLimitOf` (273), `boardCursorOf` (281), `boardCursorEncode` (292), `compareBoard` (294), `pageBoard` (302), `pageReady` (322) | used in `buildWorkClaimPage` (341–381) |
| `buildWorkClaimPage` (341) | exported; used by `server/routes/work-claims.mjs` and `server/mcp-full-profile.mjs` |
| `sweepRoom` (388) | called per request in `handleWorkClaimsCore` (721) |
| `verifiersOf` (406) | used at 1066, 1089 |
| `runPure` (413) | used at 1028+; same-named `runPure` in `server/bounty-escrow-routes.mjs` is a separate local definition, not this one |
| `doneStampOf` (437), `doneAtMsOf` (438), `receiptOf` (440) | used in receipts route (822–841); note `server/inbox-handoff.mjs` defines its own unrelated `receiptOf` |
| `receiptsQueryOf` (455), `cursorEncode` (476), `cursorDecode` (477) | used in receipts route (821–841) |
| `retire` (491) | used by `closeWorkClaim` (526); also by close/cancel core route (1161) |
| `closeWorkClaim` (502), `linkWorkClaimPullRequest` (535) | used by `server/mcp-full-profile.mjs`; `closeWorkClaim` also by `client/mcp-stdio.mjs`, `client/room-agent.mjs`, `tests/work-claim-pr-link.test.js`; `linkWorkClaimPullRequest` by `handleWorkClaims` REST early-return (598) |
| `handleWorkClaims` (587), `refuseRoomGuideOffStarter` (664), `memoizeList` (675) | entry point + core plumbing |

Also checked: constants `WARN_STATES`, `WORK_CLAIM_PROFILES`,
`BOARD_LIMIT_DEFAULT/MAX`, `BOARD_QUERY`, `RECEIPT_QUERY_PARAMS`,
`RECEIPTS_*` — all referenced within the range.
