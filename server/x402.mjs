// x402 payment-requirements logic, vendored from the tested prototype at
// ~/workspace/x402-escrow-prototype/src/x402.mjs (14/14 tests green there).
//
// Vendored verbatim EXCEPT:
// 1. Added the `solana` (mainnet) chain entry alongside `solana-devnet`.
//    The room's USDC rail denominates bounties on mainnet Solana (mint
//    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v — the well-known mainnet
//    USDC mint, which the prototype's devnet mock already used as its mock
//    mint string). Mapping the room's "solana" to the prototype's
//    "solana-devnet" key would mislabel a mainnet payout as devnet —
//    dangerous — so the entry exists under its true name.
// 2. Deliberately NOT vendored: `createFacilitator` (the mock settlement
//    simulator) and `createXPayment` (the client-side envelope builder with a
//    MOCK signature default). The room never simulates settlement of real
//    money and never builds X-Payment envelopes — the owner's wallet does
//    that with real keys. This module only describes what a payment must be
//    (the HTTP-402 `paymentRequirements` shape); it never pays.
//
// What the server returns with HTTP 402 (x402 paymentRequirements shape).
export const CHAINS = Object.freeze({
  base: Object.freeze({
    name: "Base", kind: "evm", chainId: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6,
    scheme: "eip3009", // exact: EIP-3009 transferWithAuthorization
  }),
  "solana-devnet": Object.freeze({
    name: "Solana (devnet)", kind: "svm",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6,
    scheme: "solana-transfer", // exact: memo-bound transfer instruction
  }),
  // Room addition (not in the prototype): mainnet Solana, the chain the room's
  // USDC rail denominates on. Same mint string the prototype used as its mock.
  solana: Object.freeze({
    name: "Solana", kind: "svm",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6,
    scheme: "solana-transfer", // exact: memo-bound transfer instruction
  }),
});

// What the server returns with HTTP 402 (x402 paymentRequirements shape).
export function paymentRequirements({ chain, amountRaw, payTo, resource, facilitator, maxTimeoutSecs = 300 }) {
  const c = CHAINS[chain];
  if (!c) throw new Error(`unsupported chain ${chain}`);
  if (!/^(0|[1-9][0-9]*)$/.test(String(amountRaw))) throw new Error("amountRaw must be raw-unit integer string");
  return Object.freeze({
    scheme: "exact",
    network: chain,
    asset: c.usdc,
    amount: String(amountRaw), // raw units, 6 decimals — never floats
    payTo,
    resource,
    maxTimeoutSecs,
    facilitator,
    extra: Object.freeze({ authScheme: c.scheme }),
  });
}
