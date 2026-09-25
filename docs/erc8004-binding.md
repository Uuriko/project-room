# ERC-8004 binding sketch

**Design sketch, not implementation.** No contracts, no transactions, no
chain writes in this slice. This document maps where Project Room receipts
plug into ERC-8004 so a later slice can build it without redesigning.

## What ERC-8004 is

ERC-8004 ("Trustless Agents", <https://eips.ethereum.org/EIPS/eip-8004>) is a
**draft** Ethereum standard for AI-agent identity, reputation, and
validation, authored by contributors from MetaMask, the Ethereum Foundation,
Google, and Coinbase. It defines three on-chain registries and nothing else
(communication stays with A2A/MCP; payments stay with x402 and friends):

1. **Identity Registry** — each agent gets an ERC-721 NFT identity; the
   `tokenURI` points to a JSON registration file with the agent's endpoints
   and metadata.
2. **Reputation Registry** — a standard interface for posting and querying
   feedback signals about agents (0–100 scale, uptime, success rate, …).
3. **Validation Registry** — third-party attestations that an agent actually
   did what it says it did.

The reference deployment went live on Ethereum mainnet 2026-01-29. As of
mid-2026 it had 500k+ registered agents across EVM chains.

## Binding sketch

### 1. Identity: receipt keys resolve through the registration file

A v1 receipt's `issuer` binds `{ pubkey, agentId, roomId }`
(`spec/receipt-standard-v1.md` §1). For an agent with an ERC-8004 identity,
the Ed25519 receipt-signing key is published in the agent's registration
file (the JSON behind the identity NFT's `tokenURI`):

```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "…",
  "verificationKeys": [
    { "type": "Ed25519", "publicKeyHex": "<64 lowercase hex>", "purpose": "work-receipts" }
  ]
}
```

Verification path: `receipt.issuer.agentId` → ERC-8004 identity token →
`tokenURI` → registration file → `verificationKeys` → the `pubkey` the
receipt must verify against under §3.7/§3.8. This is key *discovery*, not key
*trust*: the chain tells you which key the agent claims; whether you believe
the agent is still your decision (fail closed by default, §3.8).

### 2. Validation: receipts are attestation payloads

The validation registry exists for exactly what a v1 receipt is: a
third-party-checkable attestation that an agent did what it says. The
on-chain commitment is minimal — the `sha256` of the receipt's canonical
bytes (hashes, not content; the full receipt stays off-chain, same privacy
discipline as §2's number ban and canonical encoding). The receipt's own
`nonce` + `receiptId` give the registry its replay domain for free.

### 3. Reputation: read receipts, don't trust the registry blindly

Receipt histories are a natural input to reputation signals (completion
rate, limitation-honesty, dispute outcomes). But the honest caveat first: a
June 2026 Imperial College London study found 59–91% of ERC-8004 reputation
reviewers exhibit coordinated Sybil behavior. Permissionless reputation is
noisy; signed receipts anchor *attestations*, they do not fix Sybil. Any
reputation built on receipts needs its own anti-Sybil design — stake,
challenge bonds, secret committees (the direction our on-chain settlement
work already takes) — before the signals are worth consuming.

## Open questions for the build slice

- Key rotation: how a rotated receipt-signing key supersedes the old one in
  the registration file (validity windows, revocation list).
- Which chain(s): the standard is EVM-portable; our settlement work targets
  Monad first, Solana second — the binding should not assume Ethereum
  mainnet.
- Who pays gas for validation commitments, and when (poster? verifier?
  batched epochs?).
- Whether `agentId` maps 1:1 to the ERC-8004 token id or sits alongside it
  in the registration file.
