// Settlement envelope validator tests (200-hard-tasks #1).
// Contract guarded: every adapter must emit an envelope whose asset, chain and
// amount match the job terms, and adapters must reject the three canonical
// submission errors (wrong asset, wrong chain, wrong amount) instead of
// settling. Credible regression: an adapter binding a Solana USDC mint onto a
// Monad envelope would settle into a void — these tests make validateEnvelope
// fail that submission.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createEnvelope,
  validateEnvelope,
  assertEnvelope,
  envelopeId,
  toRaw,
  fromRaw,
  registerAsset,
  lookupAsset,
} from "../server/settlement-envelope.mjs";

const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_MONAD = "0x0b2C639c533813f4Bb9D7787C9AB3595e20efF524";

function base(over = {}) {
  return {
    jobId: "job-123",
    payer: "payer-abc",
    payee: "provider-xyz",
    chainId: "solana-mainnet",
    assetMint: USDC_SOL,
    amountRaw: toRaw("5.00", 6),
    ...over,
  };
}

describe("settlement envelope", () => {
  it("creates a valid envelope with a deterministic id", () => {
    const a = createEnvelope(base());
    const b = createEnvelope(base());
    assert.equal(a.id, b.id);
    assert.match(a.id, /^env_[0-9a-f]{32}$/);
    assert.equal(a.chain.asset.symbol, null);
    assert.deepEqual(validateEnvelope(a), []);
  });

  it("rejects a wrong-asset submission against adapter expectations", () => {
    const env = createEnvelope(base());
    const errors = validateEnvelope(env, { assetMint: "So11111111111111111111111111111111111111112" });
    assert.ok(errors.some((e) => e.startsWith("wrong-asset")), errors.join("|"));
  });

  it("rejects an envelope whose mint is unknown on the stated chain", () => {
    const errors = validateEnvelope({ ...createEnvelope(base()), chain: { id: "solana-mainnet", asset: { mint: "FakeMint1111111111111111111111111111111", decimals: 6 }, amountRaw: "100" } });
    assert.ok(errors.some((e) => e.startsWith("wrong-asset")), errors.join("|"));
  });

  it("rejects a wrong-chain submission against adapter expectations", () => {
    const env = createEnvelope(base({ chainId: "solana-mainnet" }));
    const errors = validateEnvelope(env, { chainId: "monad-mainnet" });
    assert.ok(errors.some((e) => e.startsWith("wrong-chain")), errors.join("|"));
  });

  it("rejects wrong-amount submissions and non-integer amounts", () => {
    const env = createEnvelope(base());
    assert.ok(validateEnvelope(env, { amountRaw: toRaw("5.01", 6) }).some((e) => e.startsWith("wrong-amount")));
    assert.ok(validateEnvelope({ ...env, chain: { ...env.chain, amountRaw: "5.00" } }).some((e) => e.startsWith("wrong-amount")));
    assert.ok(validateEnvelope({ ...env, chain: { ...env.chain, amountRaw: "0" } }).some((e) => e.startsWith("wrong-amount")));
  });

  it("rejects missing parties and unknown status", () => {
    assert.throws(() => createEnvelope(base({ payer: "" })), /missing payer/);
    const env = createEnvelope(base());
    assert.ok(validateEnvelope({ ...env, status: "teleported" }).some((e) => e.includes("unknown status")));
  });

  it("assertEnvelope throws a coded error carrying the error list", () => {
    const env = createEnvelope(base());
    assert.throws(() => assertEnvelope(env, { chainId: "monad-mainnet" }), (e) => e.code === "ENVELOPE_INVALID" && e.errors.length > 0);
  });

  it("converts display <-> raw amounts without float math", () => {
    assert.equal(toRaw("5.00", 6), "5000000");
    assert.equal(toRaw("0.000001", 6), "1");
    assert.equal(fromRaw("5000000", 6), "5");
    assert.equal(fromRaw("1", 6), "0.000001");
    assert.equal(fromRaw(toRaw("1234.5678", 6), 6), "1234.5678");
    assert.throws(() => toRaw("5.0.0", 6), /not a decimal/);
  });

  it("lets adapters register and look up custom assets", () => {
    registerAsset({ chainId: "monad-mock-10143", mint: "0xabc", symbol: "USDC", decimals: 6 });
    assert.equal(lookupAsset("monad-mock-10143", "0xABC").symbol, "USDC");
    assert.equal(lookupAsset("solana-mainnet", "0xabc"), null);
    assert.throws(() => registerAsset({ chainId: "x", mint: "y", symbol: "z", decimals: 1.5 }), /integer decimals/);
  });
});
