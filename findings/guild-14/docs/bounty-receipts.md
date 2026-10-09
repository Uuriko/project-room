# server/bounty-receipts.mjs — signed, externally verifiable receipts (guild-14 notes, 2026-10-09)

## What it is
Ed25519 receipt codec (518 lines) for bounty money movements. Receipts are the
tamper-evident paper trail on top of the journal.

## Flow
- `issueBountyReceipt({type, roomId, bountyId, lotId, amountMillis, actor,
  entries, entryHashes, payload, issuer, issuedAt, seedHex})`:
  builds the unsigned body → `validateShape` (number ban FIRST — JSON numbers
  are forbidden anywhere in the signed portion, dasha-receipt/1 §4) →
  canonical-JSON encode → `signBytes` → frozen receipt with 128-hex signature.
- `verifyBountyReceipt(receipt, {expectedPubkey, seen, journal})` never throws
  for an invalid receipt: returns `{ok: false, reason}`. Checks: shape, schema
  version, receiptId format, type/amount encoding (amounts are decimal
  STRINGS), actor shape, issuer pubkey hex + role == "escrow-keeper",
  RFC3339 issuedAt, payload schema per type, then the Ed25519 signature.
- `expectedPubkey` is an out-of-band trust binding: a valid signature under any
  other key is "someone signed this", not authentication.
- `seen` is a Set of receiptIds for replay protection; verified ids are added,
  replays are rejected.

## Signable journal kinds
`escrow-lock → escrow-locked`, `bond-lock → bond-locked`, `attribute →
attributed`, `payout → payout-released`, `refund → refund-issued`. Value
movements like `approve/fee/bond-return/bond-forfeit/transfer/genesis` are
journal-only, not attested transitions.

## Properties (verified by guild-14 property tests)
- Byte-identical canonical encoding (pinned to the dasha-receipt/1 Python
  reference vectors) and Ed25519 signatures.
- Forgery classes rejected: wrong-key signature, zeroed signature, amount
  tampered after signing, payload mutated after signing.
- Replay: same receiptId verified twice with `seen` is rejected on the second
  pass.

## Gotchas
- `parseStrict` rejects duplicate object keys — receipt JSON text is parsed
  strictly before verification.
- The receipt amount is a decimal string (`"10000"`), never a number — this is
  the number ban, and it exists because JSON numbers have multiple legal
  serializations.
