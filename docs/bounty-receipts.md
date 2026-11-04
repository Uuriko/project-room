# Bounty receipts — signed outcomes, signed decisions

Every value-moving bounty transition (fund, bond-lock, attribute, payout,
refund) can carry an Ed25519-signed outcome receipt
(`room-bounty-receipt/1`, `server/bounty-receipts.mjs`) that anyone can
verify offline against the journal, without trusting the room server.
Receipts are **credits-only**: they attest movements of milli-credit lots
inside the room ledger. There is no chain, asset, wallet, or cash claim
anywhere in either schema — amounts are decimal strings of milli-credits.

Signing is armed only when the operator supplies a signer: the seed comes
from the `ROOM_RECEIPT_SIGNER_SEED` environment variable (custody: secret
store only, never a file in this repo; `ROOM_RECEIPT_SIGNER_REF` optionally
overrides the issuer ref, default `escrow-keeper`). Unset or blank seed →
no signer → transitions return `signed: []`, exactly as before this slice.
A present-but-invalid seed fails the boot loudly.

## The decision + outcome pair (Option B)

An outcome receipt alone is post-hoc: it proves the keeper signed a
statement about a movement, but a fabricated agent self-report is shaped
just like one — only the key distinguishes them, and nothing in the
outcome proves the movement was *authorised before it ran*. Option B
moves the signature upstream:

1. **Decision first.** Before the escrow appends the journal entries of a
   signed movement, the keeper signs a decision receipt
   (`room-decision-receipt/1`, `server/decision-receipts.mjs`) naming the
   act (the outcome receipt type), the target (`roomId`, `bountyId`,
   `lotId`), a disposition summary (journal kind + from/to account and lot
   state), the amount, the actor, and a single-use `decisionId` + nonce.
2. **Outcome binds.** The outcome receipt issued after execution carries
   two extra payload keys: `decisionId`, and `decisionDigest` — the
   sha256 of the decision's canonical unsigned bytes. The keys are
   optional in the outcome schema (unbound receipts stay shape-valid);
   the pair verifier requires them.
3. **Surface.** Transition results carry the decision next to the outcome
   (`{ signed: [outcome], decision }`); dispute settlements collect
   decisions alongside their signed outcomes. Unarmed transitions are
   byte-for-byte what they were before: `signed: []`, no decision key.

## What a verifier must check

Use `verifyDecisionOutcomePair(decision, outcome, { expectedPubkey,
consumed, journal })` (`server/decision-receipts.mjs`). It never throws
for an invalid pair; it returns `{ ok: false, reason }`. A pair is
evidence only when **all** of these hold:

- the decision's shape and Ed25519 signature verify, and its issuer
  pubkey equals the **expected operator key** supplied out-of-band —
  executor-side signing only: a decision signed by an agent's own key is
  a self-report and fails here;
- the outcome passes `verifyBountyReceipt` under the same expected key
  (and against the journal, when one is supplied);
- the outcome's `decisionId` equals the decision's id and its
  `decisionDigest` equals the sha256 of the decision's canonical unsigned
  bytes — neither half can be swapped for a different signed artefact;
- the outcome's type, room, bounty, lot, and amount equal the decision's
  act, target, and amount — the executed movement is the authorised one;
- the `decisionId` is not already in the verifier's `consumed` set
  (single-use); a successful verification consumes it.

A fabricated outcome carrying a signature copied from a genuine decision
receipt fails (the signature does not cover the outcome's bytes). An
outcome signed with an attacker-generated key fails the expected-key
check. A genuine pair presented twice fails the second time
(`decision_consumed`). An outcome whose amount or target was altered
after signing fails the signature and the agreement checks.

## What is NOT yet true

- **No persistence.** Receipts and decisions are issued and surfaced
  in-band; there is no `bounty_receipts` table and no durable consumed
  record. The consumed set is **per-process**: single-use holds within
  one verifier process lifetime, not across restarts. The durable
  single-use record lands with the deferred persistence leg.
- **No key history or rotation.** Verification pins one expected pubkey
  out-of-band. There is no key list, no validity windows, no revocation.
- **Production remains unarmed** until the operator performs the seed
  act (setting `ROOM_RECEIPT_SIGNER_SEED` in the secret store). Nothing
  in this slice generates or stores a production key.
- **Keeper surfaces are partial.** Decisions surface on transition
  results and dispute-settlement receipts; the epoch/finalize summaries
  still surface bound outcome receipts without their decision artefacts
  (the outcomes verify standalone; pair verification there is a
  follow-up).

## Canonical encoding

Both artefacts share the codec in `server/bounty-receipts.mjs`:
canonical JSON (UTF-16 code-unit key order, exact escaping, no
whitespace), a hard ban on JSON numbers in signed bodies (amounts are
decimal strings), and Ed25519 signatures as lowercase hex — byte-identical
to the `dasha-receipt/1` reference vectors pinned in
`tests/bounty-receipts.test.js`.
