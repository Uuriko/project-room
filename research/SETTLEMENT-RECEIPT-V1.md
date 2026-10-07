# Signed Settlement Receipt Schema v1 (200-hard-tasks #4)

The receipt a provider returns per settled job, verifiable by anyone with
the standalone `dasha-verify-receipt` CLI (no room membership, no account).

Reference implementation: `server/settlement-receipt.mjs`
(issue/verify). CLI: `scripts/dasha-verify-receipt.mjs`.
Fixtures: `tests/fixtures/settlement-receipts/` (10).

## Crypto discipline

Reused verbatim from the room's signed claims (`server/bounty-receipts.mjs`):
byte-exact canonical JSON, strict duplicate-key-rejecting parse, JSON-number
ban inside signed bodies (amounts are integer strings), Ed25519 over the
canonical bytes of the body.

## Schema

```json
{
  "version": "settlement-receipt/1",
  "jobId": "job-settle-1",
  "envelopeId": "env_abc123",
  "providerId": "provider:mac-mini-07",
  "chainId": "monad-mock-10143",
  "assetMint": "0xmockUSDC",
  "amountRaw": "50000",
  "issuedAtIso": "2026-10-07T15:30:00.000Z",
  "nonce": "9f2c…(32 hex)",
  "signature": "…(128 hex, Ed25519 over canonical JSON of the body)"
}
```

The body is exactly the keys above minus `signature`, in any order
(canonicalization sorts). `amountRaw` is the settled amount in the asset's
raw units (e.g. USDC microunits) — never a float. `nonce` is 32 random hex
chars per receipt and backs replay protection.

## Verification contract

`verifySettlementReceipt(receipt, { expectedPubkey, jobId?, amountRaw?,
chainId?, maxAgeMs?, now?, seen? })` checks, in order:

1. **Shape** — exact keys, version pin, non-empty strings, positive integer
   `amountRaw`, 32-hex nonce, 128-hex signature, no JSON numbers.
2. **Signature** — Ed25519 over the canonical body against `expectedPubkey`.
3. **Job id** — matches the expected job (when supplied).
4. **Amount** — exact string match against the expected raw amount.
5. **Chain** — matches the expected chain id (when supplied).
6. **Freshness** — `issuedAtIso` parses, is not in the future beyond 5 min
   clock skew, and is not older than `maxAgeMs` (default 7 days).
7. **Replay** — when a `seen` nonce set is supplied, a repeated nonce fails.

Returns `{ ok: true, body }` or `{ ok: false, reason, code }`.

## CLI

```
node scripts/dasha-verify-receipt.mjs --pubkey <hex64> [--job <id>]
    [--amount <raw>] [--chain <id>] [--max-age-ms <n>] [--seen <journal.json>]
    <receipt.json | ->
```

Exit 0 + `VALID: …` on success; exit 1 + `INVALID: <reason> [<code>]` on
failure; exit 2 on usage errors. `--seen` persists the nonce journal so
replays are caught across runs.

## Fixtures (10)

| fixture | expected verdict |
|---|---|
| valid.json | VALID |
| forged-signature.json | INVALID bad_signature |
| wrong-amount.json | INVALID amount_mismatch |
| wrong-job.json | INVALID job_mismatch |
| expired.json (8 days old) | INVALID expired |
| replayed.json (same nonce as valid) | INVALID replay (with seen-set) |
| wrong-chain.json | INVALID chain_mismatch |
| future.json (+1h) | INVALID future_timestamp |
| tampered-provider.json | INVALID bad_signature |
| wrong-key.json | INVALID bad_signature |

## Binding to the settlement flow

The adapter's `release(id, receipt)` (tasks #6/#7) takes the provider's
settlement receipt as receipt evidence. The gateway verifies it with
`dasha-verify-receipt` semantics — signature, amount, job id, chain, freshness
— before marking the job released. The receipt's `envelopeId` ties it to the
settlement envelope (task #1); the `nonce` ties it to exactly one settlement,
so a receipt cannot be replayed for a second payout.
