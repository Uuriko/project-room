# server/bounty-escrow.mjs — money flows, lifecycle, invariants (guild-14 notes, 2026-10-09)

## What it is
Valueless-credit ledger for agent-to-agent bounties. Credits are pure ledger
units: no cash-out, no on-chain touch, no real money. 3075 lines.

## Money flow
- Genesis is the ONLY mint: 100 credits per pre-registered lane
  (`GENESIS_LANES` = jill, instinct, grokbot, codex), idempotent per room.
- Everything else is a zero-sum transfer between lot states.
- Amounts are integer milli-credits internally (1 credit = 1000); the API
  speaks credits with at most 3 decimals (`toMillis`/`toCredits`).
- `toMillis` rejects negatives, zero, NaN/Infinity, >3 decimals (tolerance
  1e-6), amounts > 1,000,000 credits, and sub-milli amounts.

## Conservation invariant (checked by `verifyConservation`)
`payable + locked + attributed + approved = total_issued`, plus:
global journal sum == genesis sum, no negative (account, lot_state) balance,
per-bounty award coverage by state, per-account hash-chain integrity.
Balances are DERIVED from the append-only, hash-chained `bounty_journal` —
never stored. Terminal bounties (paid/refunded/cancelled) must hold nothing.

## Lifecycle
Two guarded tracks (integration-map candidate #2):
- Acceptance track (verdict on work, evidence-cited):
  `claimed → submitted → accepted → approved`; disputes re-open the verdict.
- Finality track (credit-lot movements; requires a terminal acceptance verdict):
  `locked → attributed → approved → paid` (via `_sweep`), or `→ refunded`.
Intake/triage (`proposed/funded/claimed`) is pre-lifecycle, governed by neither track.

## Settlement path (the money)
1. Challenge window expires (24h micro <1 credit, 72h otherwise) →
   `finalizeBounty` (mechanical keeper, `RULE_ACTOR`) moves accepted→approved.
2. `closeEpoch` sweeps every approved bounty via `_sweep`:
   - `fee = floor(gross * 1/100)` to the room `pool` (1% fee on released payouts only),
   - `earner = gross − fee` to the claimant's payable,
   - claim bond returned (anti-flake lock, not a fee),
   - state → `paid`. `check(amount > 0)` guards against empty sweeps.
3. Disputes freeze finality while the acceptance verdict is re-decided.
   `decideDispute` outcomes: `upheld/rejected` (25% challenger bond mechanics),
   `split` (workerHalf=floor(amount/2), posterHalf=amount−workerHalf — zero-sum
   by construction), `frivolous` (bond forfeit to pool).

## Idempotency (all mutating routes)
`idemExecute(roomId, key, route, status, thunk, scope)`:
- Key without a named `callerLane` scope is REFUSED (`idempotency_scope_required`)
  — the pre-#1000 cross-member leak is closed by construction.
- Replay keyed on `(caller, route, bounty, key)` via `scope_key = "v2:"+sha256(...)`.
- Same key + different payload → `idempotency_key_reused` (never returns a
  stale body). Legacy `(room, key)` rows (version NULL) are refused with
  `idempotency_actor_mismatch` — operator reconciliation required.
- A thunk that throws leaves NO idempotency row (transaction rolls back), so a
  retry re-executes exactly once and later replays return the original body.

## Gotchas
- `CUSTODY_ENABLED` lives in settlement-router, not here: this ledger never
  moves real money.
- The claim bond (`CLAIM_BOND_MILLIS` = 1 credit; doubles at flake rung 2+;
  7-day claim cooldown at rung 3+) is separate from the award and always comes
  home on payout.
- `stateTransitionLegal`/`acceptanceTransitionLegal` are the exported pure
  legality oracles; the class enforces them in `_transition`/`_requireFinalityMove`.
- `#1019` (Oct 7): membership gates use own-key lookup only — inherited
  property names (`constructor`, `__proto__`, ...) can no longer mint phantom
  journal accounts.
- Float dust: `toMillis(0.1 + 0.2)` == 300 (tolerance absorbs IEEE error), but
  `toMillis(0.0009)` throws "at most 3 decimals" — the decimal check fires
  before the smallest-unit check.
