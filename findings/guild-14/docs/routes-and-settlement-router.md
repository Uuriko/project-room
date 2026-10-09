# server/bounty-escrow-routes.mjs + server/settlement-router.mjs (guild-14 notes, 2026-10-09)

## bounty-escrow-routes.mjs — HTTP surface over the escrow (380 lines)
- `handleBountyEscrow` sits AFTER the shared credential, fence and rate-limit
  checks. Error contract: `EscrowError` (code, no HTTP semantics) → mapped to
  HTTP here; unknown errors are rethrown for the generic 500 path — never
  wrapped, so stack traces survive.
- Every mutating route runs through `escrow.idemExecute` with a full scope
  `{callerLane, bountyId, payload minus the idempotencyKey itself}`.
  Mutant m9 (scope dropped to `callerLane: null`) was KILLED: unscoped keys
  are refused with `idempotency_scope_required`.
- `publishBountyEvent` fans bounty events out to webhooks; fan-out failures
  are logged, never fail the route.

## settlement-router.mjs — custody-vs-record-only router (77 lines)
- **RECORD-ONLY BY DESIGN.** `routeSettlement` ALWAYS returns
  `{route: "record-only", reason}` while `CUSTODY_ENABLED` is false.
  Custody (holding client funds, collecting fees, paying talent) is
  unimplemented on purpose.
- Flipping the flag is a POLICY CHANGE requiring John's explicit tap on all
  three: (1) a real funded settlement pool with a named custodian,
  (2) collection authority, (3) payout authority. Mutant m5 (flipping
  `!CUSTODY_ENABLED` → `CUSTODY_ENABLED`, which would route settlements to the
  custody branch with zero approvals) was KILLED by `demigod-jobs-money.test.js`.
- Callers record the settlement; nobody moves money on the back of this
  return value. Input validation is strict (`minorString` rejects non-decimal
  minor units).

## Dead code (reachability evidence, 2026-10-09)
- `routeSettlement`'s custody branch is INTENTIONALLY unreachable while
  `CUSTODY_ENABLED` is false — it is the shaped policy-change point, not dead
  code. Grep shows no other caller flips the flag; the flag is `export const`,
  set once at module top.
- `notifyFinalized`'s `notified` guard in bounty-disputes.mjs looks redundant
  but is reachable defense-in-depth ONLY if a future path adds a second
  terminal transition; today `requireState` blocks all of them (mutant
  m4-notify-twice survived as provably-equivalent). Keep, do not delete.
- No other unreachable code found in the slice: every export in the six
  modules is referenced by tests, routes, or another module (grep evidence in
  findings; `stateTransitionLegal` is covered by `tests/bounty-tracks.test.js`,
  `trackOfJournalKind`/`trackOfStateTransition` by `bounty-tracks.test.js`).
