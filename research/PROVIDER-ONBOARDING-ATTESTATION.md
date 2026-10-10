# Provider Onboarding: KYC/Attestation Flow (200-hard-tasks #11)

Reference implementation: `server/provider-attestation.mjs` (Ed25519,
node:crypto only). Tests: `tests/provider-attestation.test.js` (8 tests).

## What the provider proves

| claim | how it's proven |
|---|---|
| identity | controls an Ed25519 keypair; self-attestation signed by it |
| payout-address ownership | the payout address is inside the signed attestation — same key that will sign receipts (task #4) |
| capability claims | chains / workloads listed in the attestation (advisory; verified by canary, task #23) |
| terms acceptance | `termsVersion` pinned in the attestation; gateway rejects unknown versions |

What the provider does NOT prove on-chain: real-world identity. This is
pseudonymous KYC — the attestation binds a key to a payout address and to
accepted terms. Stronger identity (government ID, business verification)
is an off-band process whose *outcome* is the authority countersignature.

## Attestation schema

```jsonc
{
  "version": "provider-attestation/v1",
  "providerId": "provider:mac-1",
  "pubkeyHex": "<64 hex chars — the provider's Ed25519 key>",
  "payoutAddress": "0x…",
  "payoutChainId": "monad-mock-10143",
  "capabilities": ["monad", "llm-inference"],
  "termsVersion": "terms-2026-10-01",
  "issuedAtIso": "2026-10-07T…Z",
  "expiresAtIso": "2027-10-07T…Z",
  "nonce": "<unique>",
  "providerSignature": "<Ed25519 over canonical JSON of the above>",
  "authoritySignature": "<authority Ed25519 over canonical JSON + providerSignature>"
}
```

The canonical JSON is the fixed field order in `canonicalAttestation()`
— signatures cover exactly that, nothing more.

## Verification steps (in order)

1. **Schema:** version matches, all fields present, pubkeyHex is 64 hex
   chars, issuedAt < expiresAt.
2. **Provider self-signature:** verifies against `pubkeyHex`. Proves key
   ownership and binds the payout address.
3. **Authority countersignature:** verifies against the onboarding
   authority's pubkey, over (canonical attestation + providerSignature).
   **A bare self-attestation is never trusted** — the gateway only trusts
   what the authority endorsed after its off-band checks.
4. **Expiry window:** `issuedAt <= now < expiresAt`. Not-yet-valid and
   expired both fail.
5. **Revocation:** the provider key is not on the CRL.

Order matters: the CRL is checked last because a revocation entry is only
meaningful for an otherwise-valid attestation.

## Revocation flow

1. Authority (or automated tripwire, task #20) decides to revoke: key
   compromise, terms violation, fraud.
2. Authority issues a signed revocation:
   `{ version: "provider-revocation/v1", providerId, pubkeyHex, reason,
   revokedAtIso, authoritySignature }`.
3. The CRL (`RevocationList`) accepts it only if the authority signature
   verifies — forged revocations are rejected at add time (a griefing
   vector closed).
4. From then on, `verifyProviderAttestation` returns `revoked` for that
   key. In-flight escrows: the gateway freezes new job assignments;
   existing funded escrows continue to release-or-refund (money already
   committed is not seized — seizure is a dispute outcome, task #18).

CRL distribution: the gateway polls the authority's revocation feed;
verify calls take an optional `crl` — without one, revocation is not
checked (fail-open on the CRL is a deployment choice; production passes
the CRL always).

## Key rotation

A provider rotates by onboarding a new key (new attestation, new nonce).
The old key's attestation expires naturally or is revoked. Receipts signed
by the old key remain verifiable against the old pubkey for their
`issuedAt` window — the verifier takes the attestation that was valid
*at receipt issue time*.
