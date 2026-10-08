# Dead-code scan — work-claim-routes.mjs lines 681–1355

## Verdict: none found

Every function and export in this range has at least one live caller or is a
registered route entry. Evidence per candidate:

- `handleWorkClaimsCore` (689) — called by `handleWorkClaims` (636).
- `handleWorkClaims` (582) — imported by `server/http.mjs:26`; mounted in the
  authenticated room block.
- `closeWorkClaim` (546) — imported by `server/mcp-full-profile.mjs:20`
  (`room_close_work_claim`).
- `linkWorkClaimPullRequest` (575) — imported by `server/mcp-full-profile.mjs:20`
  (`room_link_work_claim_pr`); also called in-file by the `update`+`appendPullRequest`
  branch (592).
- `buildWorkClaimPage` (366) — imported by `server/mcp-full-profile.mjs:20`.
- `createWorkClaimRegistry` (71) — used across `tests/` (e.g.
  `tests/work-claim-leases.test.js`, `tests/receipt-search.test.js`) as the
  fixture registry; also backs the default below.
- `workClaimRegistry` (110, the default registry) — referenced by
  `handleWorkClaims` as the last-resort registry when neither
  `options.registry` nor `store.workClaims` is set; reachable at runtime.
- `fileWarningsFor` (97) — called in the `claim` route (1024) when
  `advisory: true`.
- `closeLiveClaims` (719, in-range closure) — called by the `status`, `list`,
  and `read` routes (799/806/966).
- `sweepRoom` invocation (742) — runs at the top of every request dispatch.
- `refuseRoomGuideOffStarter` (661) — 4 references in-file; invoked in
  `handleWorkClaimsCore` (694) and in both MCP entry points (560, 605).
- `memoizeList` (668) — wraps the registry inside `handleWorkClaimsCore` (690).
- `retire` (518) — called by the `close`/`cancel` route (1160) and the MCP
  `closeWorkClaim` path (567).
- All 17 route branches + the 405 fallback in `WORK_CLAIM_METHODS` (1347) are
  dispatched from `handleWorkClaimsCore`; each has at least one method entry
  and no branch is shadowed by an earlier return.

No 'probably dead / needs owner confirm' items either — the closest candidate,
`WARN_STATES` (line 95, just outside the assigned range), is used by
`fileWarningsFor` at line 98.
