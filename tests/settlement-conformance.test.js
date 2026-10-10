// Runs the canonical conformance harness (200-hard-tasks #15) against both
// local adapter legs: 100% pass required to certify.
import { createEnvelope, toRaw } from "../server/settlement-envelope.mjs";
import { createMonadAdapter, MONAD_MOCK_CHAIN_ID, MONAD_MOCK_USDC } from "../server/settlement-adapter-monad.mjs";
import { createSolanaAdapter, SOLANA_MOCK_CHAIN_ID, SOLANA_MOCK_USDC } from "../server/settlement-adapter-solana.mjs";
import { certifyAdapter } from "./settlement-conformance-harness.test.js";

function monadEnvelope(suffix) {
  return createEnvelope({
    jobId: `job-cert-monad-${suffix}`,
    payer: "buyer:demo-01",
    payee: "provider:mac-mini-07",
    chainId: MONAD_MOCK_CHAIN_ID,
    assetMint: MONAD_MOCK_USDC,
    amountRaw: toRaw("1.25", 6),
  });
}

function solEnvelope(suffix) {
  return createEnvelope({
    jobId: `job-cert-sol-${suffix}`,
    payer: "buyer:demo-01",
    payee: "provider:mac-mini-07",
    chainId: SOLANA_MOCK_CHAIN_ID,
    assetMint: SOLANA_MOCK_USDC,
    amountRaw: toRaw("1.25", 6),
  });
}

certifyAdapter("monad-mock", createMonadAdapter, monadEnvelope);
certifyAdapter("solana-mock", createSolanaAdapter, solEnvelope);
