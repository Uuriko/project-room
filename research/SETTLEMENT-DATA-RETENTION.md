# Settlement Data Retention & Privacy Policy (200-hard-tasks #16)

What settlement data is stored, for how long, and how it is deleted.
Covers the components built in tasks 1–15, 18–24.

## Data inventory

| data | where | PII? | why kept |
|---|---|---|---|
| settlement envelope (jobId, payer, payee, chain, amount) | ledger entries, API logs | **yes** — payer/payee identifiers | payment audit trail |
| provider attestation (providerId, pubkey, payout address, capabilities) | attestation registry | **yes** — payout address is a financial identifier | onboarding + payout routing |
| settlement receipts (jobId, providerId, amount, signature) | receipt journal | quasi — providerId is pseudonymous | non-repudiation evidence |
| escrow lifecycle events (fund/accept/release/refund/dispute) | adapter records, ledger | quasi — jobId linkable | dispute resolution |
| idempotency keys + cached results | idempotency store | no | exactly-once semantics (TTL'd) |
| metering records (jobId, token counts) | metering log | no | billing accuracy |
| canary results (providerId, pass/fail) | reputation inputs | quasi — providerId | quality scoring |
| dispute evidence (statements, logs) | dispute records | **yes** — may contain user content | ruling + appeals |
| tripwire alerts | alert log | no | security monitoring |
| CCTP transfer records (tx hashes, amounts) | funding log | no — chain data is public anyway | reconciliation |

Pseudonymous by design: the system never stores legal names, emails, or
government IDs for the settlement flow itself. Real-world identity, if
collected at onboarding, lives in the authority's off-band KYC system
(task #11), not in the settlement database.

## Retention schedule

| data | retention | basis |
|---|---|---|
| ledger entries (closed epochs) | **7 years** | financial audit / tax |
| ledger entries (open epoch) | until epoch close + 7 years | same |
| reconciliation journals | 7 years | audit trail |
| settlement receipts | 7 years | non-repudiation |
| dispute records + evidence | 7 years from ruling | appeals + legal |
| provider attestations (active) | while provider is active | operational |
| provider attestations (revoked/expired) | 7 years | fraud investigation |
| escrow lifecycle events | 7 years | linked to ledger |
| metering records | 2 years | billing disputes |
| canary results (raw) | 1 year | reputation recomputation |
| idempotency keys | **24 hours** | replay window only |
| API access logs | 90 days | security |
| tripwire alerts | 2 years | pattern analysis |

The 7-year window follows standard financial-record practice; it is a
policy parameter, not a legal opinion.

## Deletion flows

### 1. Provider account deletion (right to erasure)

1. Provider requests deletion; gateway verifies the request is signed by
   the provider key.
2. New job assignments stop immediately; in-flight escrows run to
   release/refund (money in motion is not destroyed).
3. After all escrows settle and the dispute window (30 days) passes:
   - attestation marked deleted; payout address redacted to `redacted`.
   - raw canary results deleted; reputation aggregates kept (anonymized).
   - metering records: jobId linkage dropped, counts kept as aggregates.
4. **Never deleted:** ledger entries, receipts, reconciliation journals,
   dispute records — these are financial records with a 7-year retention.
   The provider is informed of this before onboarding (termsVersion pins
   the policy).

### 2. Dispute evidence purge

After the appeal window closes and retention expires, evidence containing
user content is deleted; the ruling (scores, shares, rationale) is kept.
Deletion is a hard delete from the dispute store, logged in the audit log.

### 3. Idempotency store TTL

Keys expire automatically after 24h. A replay after expiry is treated as a
new operation — safe because the underlying operations are validated
against current state (e.g. fund-after-release is rejected by the state
machine, not by the idempotency layer).

### 4. Backup deletion

Backups inherit the same retention schedule; a deletion request is
recorded and applied at the next backup rotation (documented lag, not
silent non-compliance).

## Privacy design principles

1. **Minimization:** the settlement flow stores no more than it needs to
   move money and prove it moved correctly.
2. **Pseudonymity:** providerId and jobId are opaque; mapping to real
   identity requires the authority's off-band records.
3. **Append-only money, deletable metadata:** financial facts are
   immutable; everything around them (logs, raw telemetry) has a TTL.
4. **No PII in receipts:** receipts carry providerId (pseudonym), never
   payout addresses or legal names — receipts are the most widely shared
   artifact.
5. **Chain data is public:** tx hashes, amounts, and addresses on Solana /
   Monad are public by nature; the policy covers our off-chain copies,
   not the chains.
