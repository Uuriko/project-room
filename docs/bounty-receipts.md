# Bounty receipts — Ed25519-signed, externally verifiable

Every credit movement that changes who holds bounty escrow produces a
signed receipt (`room-bounty-receipt/1`) that anyone can verify offline,
without trusting the room server. The receipts are **credits-only**: they
attest movements of milli-credit lots inside the room ledger. There is no
chain, asset, wallet, funds, x402, CCTP, ERC-8004, metering, or monetary
claim anywhere in the schema — the unit is literally named
`"milli-credit"`.

## What gets signed

| Journal kind | Receipt type | Movement attested |
|---|---|---|
| `fund` | `escrow-locked` | funder payable → escrow locked |
| `claim-bond` | `bond-locked` | claimant payable → bond locked (bondKind `claim`) |
| `dispute-bond` | `bond-locked` | disputer payable → bond locked (bondKind `dispute`) |
| `attribution` | `attributed` | escrow locked → attributed to the earner |
| `payout` | `payout-released` | attributed → earner's payable (net; fee is a separate movement) |
| `refund` | `refund-issued` | escrow locked → funder's payable (reason `timeout`, `dispute-cancel`, `dispute-split`, …) |

Each receipt pins the two journal entries (debit + credit) of its movement
by entry id and entry hash, so the receipt is bound to the ledger's
hash-chained history. The journal rows are stamped with the receipt id
(`bounty_journal.receipt_id`, added by an additive migration).

## Trust model

- **Offline verification.** `verifyBountyReceipt()` is pure: give it a
  receipt object (or its canonical JSON text), an expected public key, and
  optionally a journal hash lookup and a seen-set. It never touches the
  network.
- **Expected-key binding.** A signature is only meaningful next to a key
  you already trust. Verification *requires* the caller's expected
  Ed25519 public key — without one it fails closed (`untrusted_issuer`).
  There is no key discovery, no registry, and no rotation in this slice;
  that is later work.
- **Replay scope.** Receipt ids are globally unique per issue and the
  optional seen-set rejects repeats. `roomId` inside the signed body binds
  the receipt to one room: a receipt for room A is not valid evidence in
  room B, even when both rooms share the issuer key.
- **Shape before signature.** Malformed receipts (`invalid_receipt`) and
  replays (`replayed_receipt`) are rejected before any cryptographic work.
  Tampered fields fail the signature; tampered *structure* fails the
  schema — either way the receipt is rejected.

## Canonical encoding

Byte-exact with `~/workspace/dasha-receipts/RECEIPT-SCHEMA.md`
(`dasha-receipt/1`):

- Canonical JSON: UTF-16 code-unit key ordering, UTF-8 non-ASCII output,
  exact control-character escaping, no whitespace. Verified byte-for-byte
  against the Python reference vectors (see `tests/bounty-receipts.test.js`).
- No JSON numbers anywhere in the signed body — amounts are decimal
  strings of milli-credits. A number is rejected before signature
  verification (`number_ban`).
- Ed25519 over the canonical bytes; signatures are 128 lowercase hex
  chars. Signatures reproduce the reference vectors from the same seed.

## Test / dev keys only

The room server does **not** provision a signing key in production. A
`BountyEscrow` constructed without a signer (the default) records every
movement unsigned: transitions return `signed: []` and the ledger still
conserves exactly as before. To enable signing in a test or dev room,
pass a signer built with `createReceiptSigner()`:

```js
import { createReceiptSigner } from "./bounty-receipts.mjs";
const receipts = createReceiptSigner({
  seedHex: process.env.BOUNTY_RECEIPT_SEED, // 64 lowercase hex, test key only
  ref: "test-operator",
});
const escrow = new BountyEscrow(store, { receipts });
```

`generateReceiptKeyPair()` mints throwaway keys for tests. Production key
management — a key registry, rotation, and compromise playbook — is
explicitly deferred; never point a production room at a test seed.

## Verifying a receipt

```js
import { verifyBountyReceipt } from "./bounty-receipts.mjs";
const v = verifyBountyReceipt(receipt, {
  expectedPubkey: "<64 lowercase hex>", // the issuer key you trust
  expectedIssuedAt: receipt.issuedAt,   // or a fresh timestamp to check
  seen: new Set(),                       // optional replay protection
  journal: { entryHash: id => /* sha256 hex of journal entry, or null */ },
});
v.ok;      // true only if shape, signature, issuer key, journal linkage all pass
v.reason;  // "ok" | "invalid_receipt" | "bad_signature" | "untrusted_issuer"
           // | "replayed_receipt" | "journal_mismatch"
```

The authenticated room API is the retrieval path (journal entries carry
`receipt_id`; the transition responses include `signed: [...]`); this
verifier is the offline check path.

## Amount semantics

- `amountMillis` is the **movement** amount: net to the earner for
  `payout-released`, gross for everything else.
- `payout-released` additionally carries `netAmountMillis`,
  `feeAmountMillis`, and `grossAmountMillis`, with the invariant
  `net + fee == gross` checked at issue and verify time. The 1% protocol
  fee is a separate unsigned journal movement; the signed receipt covers
  the payout leg.
- All amounts are positive decimal strings (`^(0|[1-9][0-9]*)$` for the
  fee, which may be zero). No floats, no negatives, no JSON numbers.
