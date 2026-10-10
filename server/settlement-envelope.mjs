// Chain-agnostic settlement envelope (200-hard-tasks #1).
// Pure module: builds and validates the canonical envelope every settlement
// adapter (Solana, Monad, future EVM legs) must emit before fund/release/refund.
// No I/O, no network, no secrets.
import { createHash } from "node:crypto";

// Known chain ids (mock ids for local-only adapters).
export const CHAIN_IDS = Object.freeze({
  solana: "solana-mainnet",
  monad: "monad-mainnet",
  "monad-mock": "monad-mock-10143",
  "solana-mock": "solana-mock",
});

// Known asset descriptors: { chainId, mint/address, symbol, decimals }.
const ASSETS = new Map();

export function registerAsset({ chainId, mint, symbol, decimals }) {
  if (!chainId || !mint || !symbol || !Number.isInteger(decimals) || decimals < 0) {
    throw new Error("registerAsset: chainId, mint, symbol and integer decimals required");
  }
  const key = `${chainId}:${mint.toLowerCase()}`;
  ASSETS.set(key, Object.freeze({ chainId, mint, symbol, decimals }));
  return key;
}

// Built-in canonical assets.
registerAsset({ chainId: "solana-mainnet", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 });
registerAsset({ chainId: "monad-mainnet", mint: "0x0b2C639c533813f4Bb9D7787C9AB3595e20efF524", symbol: "USDC", decimals: 6 });
registerAsset({ chainId: "monad-mock-10143", mint: "0xmock0000000000000000000000000000000000usdc", symbol: "USDC", decimals: 6 });
registerAsset({ chainId: "solana-mock", mint: "MockUsdc11111111111111111111111111111111111", symbol: "USDC", decimals: 6 });

export function lookupAsset(chainId, mint) {
  return ASSETS.get(`${chainId}:${String(mint).toLowerCase()}`) || null;
}

const STATUSES = new Set(["draft", "funded", "accepted", "released", "refunded", "cancelled", "disputed"]);

// Canonical envelope. All amounts are integer strings in the asset's raw units
// (e.g. lamport-scale USDC microunits) — never floats.
export function createEnvelope({
  jobId,
  payer,
  payee,
  chainId,
  assetMint,
  amountRaw,
  acceptance = {},
  cancellation = {},
  receiptEvidence = null,
}) {
  const envelope = {
    version: "settlement-envelope/v1",
    jobId,
    payer,
    payee,
    chain: { id: chainId, asset: { mint: assetMint, symbol: null, decimals: null }, amountRaw: String(amountRaw) },
    acceptance: {
      conditions: acceptance.conditions ?? [],
      deadlineIso: acceptance.deadlineIso ?? null,
      requiredReceipt: acceptance.requiredReceipt ?? true,
    },
    cancellation: {
      policy: cancellation.policy ?? "mutual-or-timeout",
      cancelWindowSec: cancellation.cancelWindowSec ?? null,
      refundTo: cancellation.refundTo ?? payer,
    },
    receiptEvidence,
    status: "draft",
    createdAtIso: new Date().toISOString(),
  };
  const errors = validateEnvelope(envelope);
  if (errors.length) throw new Error(`invalid envelope: ${errors.join("; ")}`);
  envelope.id = envelopeId(envelope);
  return envelope;
}

export function envelopeId(envelope) {
  const canonical = JSON.stringify({
    v: envelope.version,
    job: envelope.jobId,
    payer: envelope.payer,
    payee: envelope.payee,
    chain: envelope.chain.id,
    mint: envelope.chain.asset.mint,
    amount: envelope.chain.amountRaw,
  });
  return "env_" + createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

// Returns an array of human-readable validation errors; empty = valid.
// expected = optional adapter-side expectations used to catch
// wrong-asset / wrong-chain / wrong-amount submissions.
export function validateEnvelope(envelope, expected = {}) {
  const errors = [];
  if (!envelope || typeof envelope !== "object") return ["envelope must be an object"];
  if (envelope.version !== "settlement-envelope/v1") errors.push(`unsupported version: ${envelope.version}`);
  for (const f of ["jobId", "payer", "payee"]) {
    if (typeof envelope[f] !== "string" || !envelope[f].trim()) errors.push(`missing ${f}`);
  }
  const chain = envelope.chain || {};
  if (!chain.id || !CHAIN_IDS[chain.id] && !chain.id.endsWith("-mock") && !Object.values(CHAIN_IDS).includes(chain.id)) {
    errors.push(`unknown chain id: ${chain.id}`);
  }
  const asset = chain.asset || {};
  const known = lookupAsset(chain.id, asset.mint);
  if (!known) {
    errors.push(`wrong-asset: mint ${asset.mint} is not registered on ${chain.id}`);
  } else {
    if (asset.decimals != null && asset.decimals !== known.decimals) {
      errors.push(`wrong-asset: decimals ${asset.decimals} != canonical ${known.decimals}`);
    }
  }
  if (!/^\d+$/.test(String(chain.amountRaw ?? ""))) {
    errors.push(`wrong-amount: amountRaw must be a non-negative integer string, got ${chain.amountRaw}`);
  } else if (BigInt(chain.amountRaw) <= 0n) {
    errors.push("wrong-amount: amountRaw must be > 0");
  }
  if (envelope.status && !STATUSES.has(envelope.status)) errors.push(`unknown status: ${envelope.status}`);
  // Adapter-side expectations: the three canonical submission errors.
  if (expected.chainId && chain.id !== expected.chainId) {
    errors.push(`wrong-chain: envelope is on ${chain.id}, expected ${expected.chainId}`);
  }
  if (expected.assetMint && String(asset.mint).toLowerCase() !== String(expected.assetMint).toLowerCase()) {
    errors.push(`wrong-asset: envelope asset ${asset.mint}, expected ${expected.assetMint}`);
  }
  if (expected.amountRaw != null && String(chain.amountRaw) !== String(expected.amountRaw)) {
    errors.push(`wrong-amount: envelope amount ${chain.amountRaw}, expected ${expected.amountRaw}`);
  }
  return errors;
}

export function assertEnvelope(envelope, expected) {
  const errors = validateEnvelope(envelope, expected);
  if (errors.length) {
    const e = new Error(`envelope validation failed: ${errors.join("; ")}`);
    e.code = "ENVELOPE_INVALID";
    e.errors = errors;
    throw e;
  }
  return envelope;
}

// Amount helpers: raw <-> display units without float math.
export function toRaw(displayAmount, decimals) {
  const parts = String(displayAmount).split(".");
  if (parts.length > 2) throw new Error(`toRaw: not a decimal amount: ${displayAmount}`);
  const [whole, frac = ""] = parts;
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac)) throw new Error(`toRaw: not a decimal amount: ${displayAmount}`);
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0")).toString();
}

export function fromRaw(amountRaw, decimals) {
  const raw = BigInt(amountRaw);
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
