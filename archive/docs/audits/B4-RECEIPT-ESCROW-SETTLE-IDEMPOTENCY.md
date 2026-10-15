# B4 — Idempotency Audit: Receipt / Escrow / Settle Mutations

**Worker:** PRODUCT-200 RELIABILITY B4/50 (respawn; prior attempt died on infra error, no partial work survived — audit is fresh).
**Repo:** `Uuriko/project-room` @ `dbdd088bd` (origin/main, 2026-10-08).
**Scope:** every mutating op in `server/bounty-escrow.mjs`, `server/bounty-receipts.mjs`,
`server/bounty-escrow-routes.mjs`, `server/settlement-router.mjs`, `server/mcp-full-profile.mjs`
(bounty dispatch), `server/receipt-cards.mjs`. Read-only audit; no code changed.
**Method:** code read of each op + its route/MCP wrapper + DDL + transaction semantics;
no live execution.

All `file:line` citations are against `origin/main` @ `dbdd088bd`.

## The one mechanism everything rides on

All bounty/credit mutations funnel through `BountyEscrow.idemExecute`
(`server/bounty-escrow.mjs:3018`), called by the HTTP route wrapper
(`server/bounty-escrow-routes.mjs:130-158`) and the MCP wrapper
(`server/mcp-full-profile.mjs:368-405`, same route names/statuses/scope — parity confirmed).

- **Key source:** `Idempotency-Key` header or `idempotencyKey` body/tool field
  (`server/bounty-escrow-routes.mjs:98-103`). **Opt-in: no route requires it.**
  `key === null` → thunk runs with no record (`server/bounty-escrow.mjs:3019`).
- **Scope:** `scope_key = "v2:" + sha256(callerLane \0 route \0 bountyId \0 key)`
  (`server/bounty-escrow.mjs:3037`) — (caller, route, bounty, key). Scope without a
  caller is refused outright (`idempotency_scope_required`, `:3027`).
- **Replay:** returns the stored `{status, body}` byte-identical; the body is the
  original JSON including original signed receipts — no re-sign, no new journal
  rows (`:3046-3051`). Event fan-out is skipped on replay (`bounty-escrow-routes.mjs:155`,
  `mcp-full-profile.mjs:400`) — "retries never publish twice."
- **Key reuse with different input:** `request_hash = sha256(canonicalJson(payload))`
  with `idempotencyKey` stripped; mismatch → 409 `idempotency_key_reused` (`:3049`).
- **Exactly-once backing:** `bounty_idempotency` has
  `PRIMARY KEY(room_id, scope_key)` (`server/bounty-escrow.mjs:295`). v2 rows always
  carry a non-null `scope_key`, so the PK is a real once-only constraint for v2.
  Legacy rows (`scope_key IS NULL`, pre-#1000) slip the PK (SQLite permits NULLs in a
  PK) but are refused fail-closed at read time: any replay attempt → 409
  `idempotency_actor_mismatch` "requires reconciliation" (`:3042-3043`).
- **Concurrency:** write txns are `BEGIN IMMEDIATE` (`server/store.mjs:671`), so two
  same-key writers serialize; the loser blocks (busy_timeout 3000ms) then sees the
  committed row and replays. No `ON CONFLICT` needed. Caveat: a txn holding the lock
  >3s (a large `closeEpoch` sweep) makes a concurrent writer 500 with SQLITE_BUSY
  instead of replaying — liveness, not correctness.
- **Dedupe window:** infinite. `created_at` is stored, never pruned; rows die only on
  room purge (`server/purge-registry.mjs:427-434`). Unbounded growth + replay window
  that never expires (a months-old key replays the ancient receipt — arguably correct,
  but a growth/cleanup gap).
- **Auth before replay:** the route re-checks credential + autonomy tier *inside* the
  txn before consulting the idempotency table (`bounty-escrow-routes.mjs:134-147`);
  `rejectWork` authorizes before its settled-verdict replay (`bounty-escrow.mjs:2169-2177`).
  A replay can never be harvested by a different identity.

## Per-op matrix

| Op (route / tool) | Key? | Keyless double-submit | Replay w/ key | Settle atomicity | Verdict |
|---|---|---|---|---|---|
| `postBounty` (`POST /bounties`) | opt-in | **Double bounty**: each run mints a new `${slug}-${n}` id via atomic sequence (`bounty_sequences` upsert+RETURNING, `:1196-1202`); no natural dedupe | stored 201 + body | single txn | **partial** |
| `updateRubric` | opt-in | same content → 422 "rubric is unchanged" (`:1449`); changed → new version (correct new op) | replay | single txn | **yes** |
| `fundBounty` (`POST …/fund`) | opt-in | 2nd → `invalid_state` (state now `funded`; triage guard `:1488-1490`) | replay | single txn; escrow-lock + receipt + record update commit together | **yes** |
| `declineBounty` / `snoozeBounty` / `duplicateBounty` | opt-in | 2nd → `invalid_state` (proposed-only triage, `_triageBounty :1477`) | replay | single txn | **yes** |
| `watchBounty` | opt-in | naturally idempotent: `INSERT OR IGNORE` on `PK(room_id,bounty_id,watcher)` (`:1209`) | replay | single txn | **yes** |
| `claimBounty` (`POST …/claim`) | opt-in | 2nd → 409 `already_claimed` (`:1678`); state guard `funded`→`claimed` inside write txn | replay | single txn (bond lock + claim + event) | **yes** |
| `submitWork` (`POST …/submit`) | opt-in | 2nd → `invalid_state` (state now `submitted`, `:1718`) | replay | single txn | **yes** |
| `acceptWork` (`POST …/accept`) | opt-in | 2nd → `invalid_state` (requires `submitted`, `:2063`); finality move `attribute` gated on the acceptance verdict (`_requireFinalityMove`, `:1349`) | replay | single txn | **yes** |
| `rejectWork` (`POST …/reject`) | opt-in | **naturally idempotent**: `_settledVerdict` check returns the stored verdict with `alreadySettled:true`, `receipt.replayed:true`, zero new journal movement (`:2174-2182`) | replay | single txn; `_recordSettlement` stamps verdict on `resolution_json` + immutable `bounty.settled` event (`:2131-2157`) | **yes** |
| `disputeBounty` (`POST …/dispute`) | opt-in | 2nd → 409 `dispute_exists` (`:2277`) | replay | single txn (bond lock + machine open/challenge/evidence/seat) | **yes** |
| `decideDispute` (`POST …/dispute-decide`) | opt-in | 2nd → `invalid_state` (dispute machine can't re-finalize; `_onDisputeFinalized` returns early when `resolution_json` set, `:2401-2406`) | replay | single txn (verdict → `_settleDispute` → resolution + settlement record + event) | **yes** |
| `finalizeBounty` (`POST …/finalize`) | opt-in | keeper pass on terminal bounty → 422 "nothing to finalize" (`:2702-2711`); dispute timeout-default retry guarded by `!bounty.resolution` (`:2686`) | replay | single txn | **yes** |
| `closeEpoch` (`POST …/epoch-close`) | opt-in | 2nd run finds no `approved` bounties → empty summary (no-op). `_sweep` pays exactly `_approvedMillis` (journal SUM, `:2625-2628`), state → `paid` (terminal, `:142`), fee 1% only on released payouts | replay | **whole epoch in one txn** (`:2718`); per-bounty logic errors recorded in `summary.failed` and skipped, DB errors roll back everything | **yes** (caveat: partial-epoch-on-logic-error is by design) |
| `transfer` (`POST …/transfer`) | opt-in | **DOUBLE-MOVES credits**: payable→payable, no bounty record, no state transition, no guard (`:2754-2773`) | replay | single txn | **no** |
| `resolveSybilFlag` (`sybil-dismiss/confirm`) | opt-in | 2nd → `invalid_state` (requires `status='open'`, `:1938`) | replay | single txn | **yes** |
| `appendRoomEvent` / `postReceiptCard` (`receipt-cards.mjs`) | n/a (event id) | no-op: `SELECT 1 FROM events WHERE id=?` guard; "a second done notification for the same id is a no-op" (`:24, :56`) | n/a | single txn (`isolated:true`) | **yes** |

## Cross-cutting findings

1. **Journal movements have no once-only constraint of their own.** `bounty_journal`
   has `entry_id TEXT NOT NULL UNIQUE` (`:212-228`) but ids are `ent_`+randomUUID
   (`:635`), so the UNIQUE is accidental-collision armor, not dedupe. The once-only
   property for every money leg rests on (a) the state-machine guard, (b) the
   settlement-verdict check, or (c) the idempotency table — never on a journal
   constraint. Hash chains (`prev_hash`/`hash`, verified by `verifyConservation`
   `:2950`) detect tampering, not duplication.
2. **`transfer` is the only op where keyless retry double-executes.** Every other
   mutating op degrades safely without a key (error or no-op). The route docblock
   says "every mutating route accepts an idempotency key" (`bounty-escrow-routes.mjs:33`)
   — accepts, not requires — and `transfer` is where that optionality is money-unsafe.
3. **Receipt issuance sits in the critical path, not as a sidecar.** `_issueReceipt`
   signs (Ed25519) and stamps `receipt_id` onto both journal entries inside the same
   DB txn as the movement (`:1098-1116`). A receipt-shape bug rolls back the whole
   settlement (the H-21 precedent is documented in `bounty-receipts.mjs`'s
   `refund-issued` schema, whose reason vocabulary had to cover every reason the
   escrow emits). Consequence for idempotency: a failed attempt never inserts the
   idempotency row (insert happens after the thunk succeeds, `:3053`), so retry with
   the same key re-executes cleanly — correct.
4. **Verification-side replay protection is caller-managed.** `verifyBountyReceipt`'s
   `seen` set is supplied by the caller; the server never records which receipts it
   has verified (`bounty-receipts.mjs:428-476`). Re-verifying doesn't move money, but
   any consumer that treats "valid receipt" as "paid" needs its own dedupe.
5. **`settlement-router.mjs` is record-only by design** (`CUSTODY_ENABLED = false`,
   `:20`): no real-money custody exists, so all "settle" findings above concern
   credit lots only. If custody is ever enabled, this audit's transfer finding becomes
   a real-funds double-spend and must be re-run against the custody branch.
6. **Settlement exactly-once per claim holds via three independent guards:**
   `_recordSettlement`'s `_settledVerdict` no-op (`:2139-2140`), `_onDisputeFinalized`'s
   `resolution_json` early-return (`:2406`), and the dispute-machine state machine
   (can't re-finalize). All reads/writes are inside `BEGIN IMMEDIATE` txns, so the
   check-then-act is race-safe in the single-process server.

## Worst finding (for B11)

**`POST /credits/transfer` double-moves credits on keyless retry**
(`server/bounty-escrow.mjs:2754-2773`, route `server/bounty-escrow-routes.mjs:342-349`).
Repro: client POSTs a transfer, times out before reading the 200, retries without an
`Idempotency-Key` → both executions move the full amount (payable→payable has no
state transition and no natural guard, unlike every bounty-lifecycle op). The
idempotency mechanism fully covers it *if* the client sends a key — the gap is that
nothing requires one, and this is the one money-moving op where the fallback is
silent double-spend rather than a safe error. Fix direction (for B11, not this audit):
require the key on `credit.transfer` (and arguably `bounty.post`), or add a
client-supplied transfer nonce with a unique constraint.

## Verdict summary for the B1 matrix

- **yes:** updateRubric, fund, decline/snooze/duplicate, watch, claim, submit, accept,
  reject (incl. natural settlement replay), dispute, dispute-decide, finalize,
  epoch-close, sybil resolve, receipt cards.
- **partial:** postBounty (keyless retry → duplicate bounties, distinct ids, double
  fundable budget), idempotency store (no TTL/pruning — infinite window, unbounded growth).
- **no:** `transfer` without an idempotency key — the single double-execution path in
  the money-adjacent surface.
