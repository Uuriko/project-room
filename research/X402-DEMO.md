# x402-Style Payment-Gated API Demo (200-hard-tasks #9)

Runnable demo: `scripts/x402-demo-server.mjs` (mock provider) +
`scripts/x402-demo-client.mjs` (client). Tests: `tests/x402-demo.test.js`
(7 tests). Run it:

```
node scripts/x402-demo-server.mjs 8099 &
node scripts/x402-demo-client.mjs http://127.0.0.1:8099
# -> status: 200, inference result
```

## The x402 flow, as demonstrated

```
client                              provider
  | GET /inference                     |
  |----------------------------------->|
  | 402 + { accepts: [{ asset: USDC,   |
  |   amountRaw, payTo, chainId,       |
  |   scheme, validForSec }] }         |
  |<-----------------------------------|
  | sign authorization over            |
  | (payTo, asset, chainId, amountRaw, |
  |  nonce, expiresAt)                 |
  | GET /inference                     |
  | X-Payment: <base64url auth>        |
  |----------------------------------->|
  | verify: payee, asset, amount >=    |
  | price, expiry, nonce unused,       |
  | signature valid                    |
  | 200 + result                       |
  |<-----------------------------------|
```

This is the x402 pattern (HTTP 402 as a payment handshake, signed
payment authorization retried in a header) with one substitution:

| x402 (production) | this demo | why |
|---|---|---|
| EIP-3009 `transferWithAuthorization` on Base | Ed25519-signed JSON authorization | no EVM toolchain on this machine; the signature/authorization semantics are identical |
| secp256k1 | Ed25519 | consistent with the receipt stack (task #4) |
| facilitator settles on-chain | mock: verification only, no chain | the demo proves the gate, not settlement |

## What the server enforces

1. **No payment → 402**, always, with machine-readable requirements.
2. **Amount floor** — `amountRaw >= price`; overpayment accepted (no change
   given; the client should sign exact).
3. **Expiry** — authorizations live 300s; stale ones are rejected.
4. **Single-use nonces** — each authorization buys exactly one request;
   replay → 402 `nonce-reused-or-missing`.
5. **Signature binding** — the signature covers (payTo, asset, chainId,
   amountRaw, nonce, expiresAt, payerPubkeyHex); tampering with any field
   breaks verification.

## Honest framing

This demo proves the *mechanism* (payment-gated serving with signed
authorizations). It does not prove demand: prior research found credible
x402 demand concentrated in a narrow band (TRM's reported $5–11K/mo), so
this stays a protocol option for provider monetization, not a revenue
pillar. If adopted, the production version would use real EIP-3009 on the
settlement chain with a facilitator, and the nonce registry would be
durable (this demo's is in-memory).

## Mapping to the settlement stack

- The `payTo` would be the job's escrow (task #5's state machine), not a
  treasury — per-request micropayments fund the escrow that later releases
  to the provider.
- The signed authorization is the same shape as a settlement receipt
  (task #4): a signed statement binding payer, amount, and scope. A
  provider could batch authorizations into one on-chain settlement.
- Metering (task #22) sets the price: `amountRaw` per request derives from
  expected token usage × the rate card (task #21).
