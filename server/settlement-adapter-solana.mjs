// Solana settlement adapter (200-hard-tasks #7), local-only.
// Wraps the Solana settlement path behind the same envelope/adapter
// interface as the Monad leg: mock program interactions, identical envelope
// semantics. Same deviation as #6: in-memory mock, no on-chain calls on the VM.
import { SettlementAdapter } from "./settlement-adapter.mjs";

export const SOLANA_MOCK_CHAIN_ID = "solana-mock";
export const SOLANA_MOCK_USDC = "MockUsdc11111111111111111111111111111111111";

export function createSolanaAdapter(options = {}) {
  return new SettlementAdapter({
    name: options.name || "solana-mock",
    chainId: SOLANA_MOCK_CHAIN_ID,
    assetMint: SOLANA_MOCK_USDC,
    assetDecimals: 6,
  });
}

// Mock Solana program interaction record: what a real program call would
// replace. Throws on unknown instructions (per repo AGENTS.md: no stub that
// accepts unknown methods).
const KNOWN_INSTRUCTIONS = new Set(["escrow.fund", "escrow.release", "escrow.refund", "escrow.cancel"]);

export function mockProgramCall(adapter, instruction, accounts) {
  if (!KNOWN_INSTRUCTIONS.has(instruction)) {
    throw new Error(`mockProgramCall: unknown instruction ${instruction}`);
  }
  return { adapter: adapter.name, instruction, accounts, chainId: adapter.chainId, mocked: true };
}
