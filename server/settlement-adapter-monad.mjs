// Monad EVM-path settlement adapter (200-hard-tasks #6), local-only.
// Mock chain id 10143, mock USDC, mock escrow calls — same envelope semantics
// as every other adapter leg. Deviation from the task text: no Anvil/Solidity
// toolchain exists on this VM (and dasha-settlement is a separate repo), so the
// adapter is an in-memory mock implementing the shared interface in
// server/settlement-adapter.mjs, exercised by node --test. A real Monad leg
// replaces mockEscrowCall with contract calls; the envelope + transition
// contract does not change.
import { SettlementAdapter } from "./settlement-adapter.mjs";

export const MONAD_MOCK_CHAIN_ID = "monad-mock-10143";
export const MONAD_MOCK_USDC = "0xmock0000000000000000000000000000000000usdc";

export function createMonadAdapter(options = {}) {
  return new SettlementAdapter({
    name: options.name || "monad-mock",
    chainId: MONAD_MOCK_CHAIN_ID,
    assetMint: MONAD_MOCK_USDC,
    assetDecimals: 6,
  });
}

// Mock escrow call: what a real Monad facilitator would replace.
// Records the call so tests can assert the exact mock-chain interactions.
export function mockEscrowCall(adapter, method, args) {
  return { adapter: adapter.name, method, args, chainId: adapter.chainId, mocked: true };
}
