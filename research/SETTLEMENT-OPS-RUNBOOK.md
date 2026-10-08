# Settlement Ops Runbook (200-hard-tasks #17)

Incident response for the settlement flow. Severity: **P1** (money stuck
or moving wrongly — page now), **P2** (degraded — fix within the day),
**P3** (hygiene — next cycle). Every incident ends with a ledger
reconciliation for the affected epoch (task #14).

## 1. Escrow funded but provider never starts (P2)

- **Symptoms:** escrow `funded` past the start SLA; provider silent;
  tripwire `job-started-after-fund` (task #20) fires.
- **Diagnosis:** check provider attestation status (revoked? expired —
  task #11); check provider's recent canary pass rate (task #23); check
  whether the funding hook actually credited the escrow (CCTP transfer
  status — task #8).
- **Remediation:** if the provider is unresponsive past the no-show
  window → open a dispute (task #18, provider-no-show → refund + slash);
  if the funding never landed → re-run the CCTP transfer, then refund.
- **Escalation:** P1 if the escrow value is large or many jobs are
  affected (provider-wide outage → revoke attestation, task #11).

## 2. Release fails: receipt rejected (P2)

- **Symptoms:** `POST .../release` returns 422 `BAD_RECEIPT`.
- **Diagnosis:** pull the receipt and run `verifySettlementReceipt`
  locally — distinguish `bad_signature` (provider key wrong/rotated),
  `amount_mismatch` (envelope vs receipt), `stale`/`replay` (nonce reuse),
  `wrong_job` (receipt for another job).
- **Remediation:** bad signature + key rotation in progress → ask the
  provider to re-issue with the current key; amount mismatch → do NOT
  override, open a dispute; replay → investigate duplicate submission.
- **Escalation:** P1 if many providers hit it at once (suggests a gateway
  regression in what it tells providers to sign).

## 3. Chain reorg after fund observed (P1)

- **Symptoms:** adapter saw `funded` on Solana/Monad, then the funding tx
  disappears from the canonical chain.
- **Diagnosis:** confirm reorg depth vs finality threshold; check whether
  the burn/mint still exists on the canonical fork.
- **Remediation:** mark the escrow `funding-uncertain` (no new state
  transitions); if the tx is gone → revert escrow to `unfunded` and
  re-initiate funding; if it reappears → resume. Never release on a
  reorged fund.
- **Escalation:** page the on-call; P1 until every affected escrow is
  re-resolved. Post-mortem on finality thresholds.

## 4. CCTP attestation stall (P2 → P1 at 1h)

- **Symptoms:** transfer stuck in `burn_initiated` past the mode's ETA
  (fast: minutes; standard: tens of minutes); poller timing out.
- **Diagnosis:** check Circle attestation service status; check the burn
  tx is actually on Solana (maybe the burn itself failed); check fee —
  fast-transfer LPs reject underpriced quotes.
- **Remediation:** transient → `pollWithRetry` with backoff (the burn is
  still valid); hard timeout → re-request attestation; burn failed →
  refund the payer on source and re-quote.
- **Escalation:** P1 at 60 min or if the treasury refill path stalls.

## 5. Ledger reconciliation mismatch (P1)

- **Symptoms:** `ledger-reconcile` reports `missing-on-chain`,
  `missing-in-ledger`, or `amount-mismatch`; epoch close-out blocked.
- **Diagnosis:** classify per the reconciler output — phantom booking
  (bug), unbooked movement (late chain data or theft), amount drift
  (decimal bug or tamper).
- **Remediation:** do NOT force-close the epoch. Phantom → fix the
  booking bug, add an adjusting entry. Unbooked → investigate as potential
  theft (see #9) before booking an adjustment. Amount drift → find which
  side is wrong; the chain is ground truth for amounts.
- **Escalation:** any `amount-mismatch` on a large value → P1 + security
  review; treat as potential tampering until proven a bug.

## 6. Suspected theft / unauthorized movement (P1)

- **Symptoms:** `missing-in-ledger` for a movement nobody authorized;
  tripwire on anomalous payout; provider reports funds they didn't earn.
- **Diagnosis:** freeze first, diagnose second. Pull the chain records,
  the gateway audit log, and the key-access log.
- **Remediation:** freeze funding (stop new escrows); rotate the gateway
  identity secret if compromise is possible; revoke suspect provider
  attestations; preserve all logs.
- **Escalation:** page immediately. This is the one incident where speed
  beats precision — containment first.

## 7. Idempotency store outage (P2)

- **Symptoms:** fund/release calls fail or behave non-idempotently;
  duplicate bookings appear.
- **Diagnosis:** check the store (latency, errors); check whether
  duplicates actually double-booked (ledger totals vs chain).
- **Remediation:** fail closed — reject new fund/release calls until the
  store is healthy (a rejected call is retryable; a double-booked one is
  a reconciliation incident). Reconcile the affected epoch before
  resuming.
- **Escalation:** P1 if any double-booking is confirmed (becomes #5).

## 8. Provider key compromise (P1)

- **Symptoms:** provider reports key theft; or receipts appear the
  provider denies issuing; tripwire on receipt anomaly.
- **Diagnosis:** confirm with the provider over a second channel;
  identify the window of suspect receipts.
- **Remediation:** revoke the attestation (task #11 CRL); freeze new
  assignments; already-funded escrows continue to release-or-refund
  (money in motion is not seized); re-verify all receipts in the suspect
  window.
- **Escalation:** page; the provider re-onboards with a new key when
  ready.

## 9. Tripwire evaluator failure (P2)

- **Symptoms:** tripwire alerts stop, or the evaluator crashes on config
  load; `evaluate-tripwires` exits non-zero.
- **Diagnosis:** validate `research/tripwire-rules.yaml` against the
  parser; check the last successful evaluation timestamp.
- **Remediation:** the evaluator fails closed — fix or revert the config,
  never bypass. Backfill the missed window by re-running over the journal.
- **Escalation:** P1 if the outage overlapped a suspected #5 or #6.

## 10. Gateway identity secret rotation (P3, planned)

- **Symptoms:** n/a — scheduled.
- **Diagnosis:** n/a.
- **Remediation:** mint the new secret, deploy to the gateway, verify a
  canary fund/release with the new secret, then revoke the old. No
  in-flight escrow is affected (the secret authenticates the caller, not
  the escrow).
- **Escalation:** if rotation fails mid-way, both secrets are valid
  briefly — complete the rotation, never leave two live secrets.

## General rules

1. **Money incidents are P1 by default.** When in doubt, page.
2. **Freeze before diagnosing** for #5 and #6 — a running system can keep
   losing money while you investigate.
3. **The ledger is the source of truth for what we believe; the chain is
   the source of truth for what happened.** Reconcile them before
   declaring any incident resolved.
4. **Every P1 gets a post-mortem** within 48h: timeline, root cause, what
   the tripwires caught/missed, and one structural fix (not just "be more
   careful").
5. **Runbook drills:** each quarter, game one incident (#3 and #6
   alternate) with the on-call team against the simulator scripts.
