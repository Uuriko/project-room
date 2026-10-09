# Guild-14 mutation testing — money slice (2026-10-09)

Slice: `server/bounty-escrow.mjs`, `server/bounty-disputes.mjs`,
`server/bounty-receipts.mjs`, `server/bounty-reputation.mjs`,
`server/bounty-escrow-routes.mjs`, `server/settlement-router.mjs`.
Driver: `mutdriver.mjs`; specs in `mutspecs/`; raw logs
`mutantlog-<unit>-<mutant>.txt`.

## Scoreboard — 23 mutants, 16 killed, 7 survived (of which 1 real bug, 2 equivalent, 3 test gaps closed by new regressions, 1 conservative-but-unpinned)

| unit | file | mutant | status | verdict |
|---|---|---|---|---|
| g14-m1 | bounty-escrow | m1-fee-ceil (`Math.floor`→`ceil` on 1% pool fee) | SURVIVED | test gap → `tests/g14-reg-fee-floor.test.js` added |
| g14-m1 | bounty-escrow | m1-tomillis-drop-decimal-check | KILLED | — |
| g14-m1 | bounty-escrow | m1-split-ceil (workerHalf ceil) | KILLED | — |
| g14-m1 | bounty-escrow | m1-sweep-nonnegative (`>0`→`>=0`) | KILLED | — |
| g14-m1 | bounty-escrow | m1-dispute-bond-floor (bond ceil→floor) | KILLED | — |
| g14-m2 | bounty-escrow | m2-drop-hash-check | KILLED | — |
| g14-m2 | bounty-escrow | m2-drop-scope-require | KILLED | — |
| g14-m2 | bounty-escrow | m2-legacy-bypass | KILLED | — |
| g14-m2 | bounty-escrow | m2-skip-version (drop `AND version=2` in replay lookup) | SURVIVED | equivalent: `scope_key` is always `v2:sha256(...)`; legacy rows have NULL scope_key, so the filter can never match a different row |
| g14-m3 | bounty-escrow | m3-dispute-claimant-invert | KILLED | — |
| g14-m3 | bounty-escrow | m3-dispute-state-widen (`check(true, ...)` on disputable states) | SURVIVED | test gap → `tests/g14-reg-dispute-state-gate.test.js` added |
| g14-m3 | bounty-escrow | m3-transition-widen (`stateTransitionLegal`→`true`) | SURVIVED | **spec error, not a gap**: the killing test file (`bounty-tracks.test.js`) was not in this unit's test list. Re-run as g14-m7 with the correct file → KILLED. |
| g14-m7 | bounty-escrow | m7-transition-widen-retest | KILLED | confirms m3 was a unit-scope mistake |
| g14-m4 | bounty-disputes | m4-bond-min-ceil (min bond floor→ceil) | SURVIVED | **REAL BUG** — see below |
| g14-m4 | bounty-disputes | m4-notify-twice (drop `notified` guard) | SURVIVED | equivalent: `requireState` rejects any second terminal transition, so the guard is unreachable defense-in-depth |
| g14-m4 | bounty-disputes | m4-max-cost-ceil (cost cap floor→ceil) | SURVIVED | test gap on cap rounding; floor is the conservative choice (over-rejects fractional costs), so no bug — pinned note only |
| g14-m4 | bounty-disputes | m4-require-state-skip | KILLED | — |
| g14-m5 | settlement-router | m5-custody-flip (`!CUSTODY_ENABLED`→`CUSTODY_ENABLED`) | KILLED | custody branch stays unreachable without approval |
| g14-m6 | bounty-receipts | m6-verify-skip | KILLED | — |
| g14-m6 | bounty-receipts | m6-issue-unsign (zeroed signature) | KILLED | — |
| g14-m8 | bounty-reputation | m8-probation-offbyone (`>`→`>=` on probation cap) | KILLED | — |
| g14-m8 | bounty-reputation | m8-flake-reason-flip (flake signal on non-timeout) | KILLED | — |
| g14-m9 | bounty-escrow-routes | m9-route-dropscope (callerLane→null) | KILLED | unscoped keys refused, as designed |

## Real bug found (1)

**`server/bounty-disputes.mjs:116` — minimum dispute bond can undercut the
documented 5% of the bounty.** The module comment says
"open bond = max($1, 5% of bounty)", but
`const minimum = Math.max(1, Math.floor(bountyAmount * MIN_BOND_RATIO));`
floors the 5%, so the minimum can sit up to just under 1 unit below 5%.
Repro (verified against live code): `open({ disputeId:"d1", bountyId:"b1",
bountyAmount: 21, raisedBy:"x", reason:"r", bond: 1 })` is ACCEPTED, and
1/21 = 4.76% < 5%. Fail-first repro:
`findings/guild-14/regressions/g14-reg-dispute-bond-min-failfirst.test.js`
(fails on current code, passes with `Math.ceil`). One-word fix:
`Math.max(1, Math.ceil(bountyAmount * MIN_BOND_RATIO))`.
Severity: low — the escrow-side 25% bond (the one that actually locks funds)
uses `Math.ceil` and is unaffected; this is the dispute machine's floor for
the 5% minimum, so the exposure is < 1 milli-unit of under-bonding per
dispute. Recommended fix with a changelog note, not a hot path.

## Regressions added to `tests/` (pass on current code, fail on the mutant)

- `tests/g14-reg-fee-floor.test.js` — pins floor on the 1% pool fee
  (10.001 credits → fee exactly 0.1 credits).
- `tests/g14-reg-dispute-state-gate.test.js` — disputing in proposed / funded /
  claimed / paid states is rejected `invalid_state`.
