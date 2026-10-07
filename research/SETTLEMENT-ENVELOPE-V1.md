# Settlement Envelope v1 (200-hard-tasks #1)

One canonical schema every settlement adapter (Solana, Monad, future EVM legs)
must emit before fund / release / refund. Reference implementation:
`server/settlement-envelope.mjs` (validator + `toRaw`/`fromRaw` amount math).

## JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://trydemigod.com/specs/settlement-envelope-v1.json",
  "title": "SettlementEnvelope",
  "type": "object",
  "required": ["version", "jobId", "payer", "payee", "chain", "acceptance", "cancellation", "status"],
  "properties": {
    "version": { "const": "settlement-envelope/v1" },
    "id": { "type": "string", "pattern": "^env_[0-9a-f]{32}$" },
    "jobId": { "type": "string", "minLength": 1 },
    "payer": { "type": "string", "minLength": 1 },
    "payee": { "type": "string", "minLength": 1 },
    "chain": {
      "type": "object",
      "required": ["id", "asset", "amountRaw"],
      "properties": {
        "id": { "type": "string" },
        "asset": {
          "type": "object",
          "required": ["mint"],
          "properties": {
            "mint": { "type": "string" },
            "symbol": { "type": ["string", "null"] },
            "decimals": { "type": ["integer", "null"] }
          }
        },
        "amountRaw": { "type": "string", "pattern": "^[1-9][0-9]*$" }
      }
    },
    "acceptance": {
      "type": "object",
      "properties": {
        "conditions": { "type": "array", "items": { "type": "string" } },
        "deadlineIso": { "type": ["string", "null"], "format": "date-time" },
        "requiredReceipt": { "type": "boolean" }
      }
    },
    "cancellation": {
      "type": "object",
      "properties": {
        "policy": { "type": "string", "enum": ["mutual-or-timeout", "payer-anytime", "none"] },
        "cancelWindowSec": { "type": ["integer", "null"], "minimum": 0 },
        "refundTo": { "type": "string" }
      }
    },
    "receiptEvidence": { "type": ["object", "null"] },
    "status": { "type": "string", "enum": ["draft", "funded", "accepted", "released", "refunded", "cancelled", "disputed"] }
  }
}
```

## Validation rules

1. **Version pin.** `version` must be exactly `settlement-envelope/v1`; unknown versions reject.
2. **Parties.** `jobId`, `payer`, `payee` are non-empty strings.
3. **Chain id known.** Must be a registered chain (`solana-mainnet`, `monad-mainnet`,
   `monad-mock-10143`, `solana-mock`, or a registered custom id).
4. **Wrong-asset.** `chain.asset.mint` must be registered on `chain.id`, and any
   stated `decimals` must equal the canonical decimals. Violation error: `wrong-asset`.
5. **Wrong-amount.** `amountRaw` must be a non-zero integer string (no floats,
   no decimals, no negatives — amounts are in the asset's raw units, e.g. USDC
   microunits). Violation error: `wrong-amount`.
6. **Wrong-chain.** When the adapter states expectations (`expected.chainId`),
   the envelope's chain id must match exactly. Violation error: `wrong-chain`.
7. **Expectations match.** `expected.assetMint` (case-insensitive) and
   `expected.amountRaw` (exact string) must match when supplied — this is the
   adapter-side double-entry check that catches cross-chain mint confusion.

`validateEnvelope(env, expected)` returns `[]` on success and an array of
human-readable errors otherwise. `assertEnvelope` throws `ENVELOPE_INVALID`
carrying `.errors`.

## Worked examples

### Example A — Solana job ($5.00 USDC)

```json
{
  "version": "settlement-envelope/v1",
  "id": "env_9f2c…(sha256 of canonical fields)",
  "jobId": "job-sol-7741",
  "payer": "buyer:demo-01",
  "payee": "provider:mac-mini-07",
  "chain": {
    "id": "solana-mainnet",
    "asset": { "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "symbol": "USDC", "decimals": 6 },
    "amountRaw": "5000000"
  },
  "acceptance": {
    "conditions": ["receipt signature valid", "token count within 2% of metered"],
    "deadlineIso": "2026-10-08T06:00:00.000Z",
    "requiredReceipt": true
  },
  "cancellation": { "policy": "mutual-or-timeout", "cancelWindowSec": 3600, "refundTo": "buyer:demo-01" },
  "receiptEvidence": null,
  "status": "draft"
}
```

### Example B — Monad job ($0.05 USDC)

Same shape on `monad-mainnet` with mint `0x0b2C639c533813f4Bb9D7787C9AB3595e20efF524`,
`amountRaw: "50000"` (5 cents in microunits), and an `acceptance.conditions`
entry `"canary sample accepted"`.

### Example C — Refunded job

Envelope for a cancelled Solana job: identical chain block to Example A,
`"status": "refunded"`, `cancellation.policy: "mutual-or-timeout"`,
`cancellation.refundTo: "buyer:demo-01"`, and `receiptEvidence` carrying the
refund transaction reference `{ "tx": "5xR…", "refundedRaw": "5000000" }`.

## Conformance note

The shared adapter conformance suite (200-hard-tasks #15,
`tests/settlement-conformance.test.js`) runs every adapter through the
wrong-asset / wrong-chain / wrong-amount submissions against these rules; an
adapter passes only if `validateEnvelope` (or its on-chain equivalent) rejects
all three.
