// CCTP v2 funding simulator (200-hard-tasks #8).
// Local simulator for cross-chain funding Solana -> Monad USDC via CCTP v2,
// with mocked attestations: deposit-for-burn, attestation polling with
// backoff, fast-transfer vs standard timing asymmetry, hook-handler
// metadata (the destination hook auto-funds the settlement escrow), and
// injected failures. Seeded RNG; virtual clock (no real waiting).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DOMAINS = Object.freeze({ solana: 5, monad: 10143 });
export const MODES = Object.freeze(["fast", "standard"]);

// Attestation latency model (virtual seconds): fast transfer settles via
// liquidity in seconds; standard waits for Circle attestation finality.
const ATTESTATION_LATENCY = {
  fast: { min: 1, max: 4 },
  standard: { min: 600, max: 1200 },
};
const FEES_BPS = { fast: 10, standard: 1 }; // 0.10% vs 0.01%

export function quote({ amountRaw, mode }) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`);
  const amount = BigInt(amountRaw);
  if (amount <= 0n) throw new Error("quote: amountRaw must be > 0");
  const fee = (amount * BigInt(FEES_BPS[mode])) / 10000n;
  const { min, max } = ATTESTATION_LATENCY[mode];
  return {
    mode, amountRaw: amount.toString(), feeRaw: fee.toString(),
    netRaw: (amount - fee).toString(),
    etaSec: { min, max },
    sourceDomain: DOMAINS.solana, destDomain: DOMAINS.monad,
  };
}

// A transfer through the mocked CCTP flow. Virtual clock: `nowSec` advances
// as the poller polls. `faults` injects failures (see failure table in doc).
export function createTransfer({ transferId, jobId, envelopeId, amountRaw, mode, seed = 1, faults = {} }) {
  const rand = mulberry32(seed);
  const q = quote({ amountRaw, mode });
  const { min, max } = ATTESTATION_LATENCY[mode];
  const attestedAt = min + rand() * (max - min);
  const state = {
    transferId, jobId, envelopeId, mode,
    amountRaw: q.amountRaw, feeRaw: q.feeRaw, netRaw: q.netRaw,
    status: "burn_initiated",
    burnAtSec: 0,
    attestedAtSec: faults.neverAttests ? Infinity : attestedAt,
    nowSec: 0,
    polls: 0,
    hookExecuted: false,
    hookMetadata: null,
    error: null,
  };

  // Hook data carried in the CCTP v2 message: the destination hook calls
  // the funding escrow with this metadata so the mint auto-funds the job.
  const hookData = {
    hook: "funding-escrow",
    jobId,
    envelopeId,
    expectedNetRaw: q.netRaw,
    asset: "USDC",
  };
  let timeoutFired = false; // the attestation-timeout fault is transient: fires once

  function poll({ pollIntervalSec = 5, timeoutSec = 3600 } = {}) {
    if (state.status === "minted") return { ...state, replayed: true };
    if (state.status === "failed") return { ...state };
    state.polls++;
    state.nowSec += pollIntervalSec;
    if (faults.attestationTimeoutAt && !timeoutFired && state.nowSec >= faults.attestationTimeoutAt && state.status === "burn_initiated") {
      timeoutFired = true;
      state.status = "failed";
      state.error = "attestation-timeout";
      return { ...state };
    }
    if (state.nowSec >= state.attestedAtSec) {
      if (faults.hookReverts && !state.hookExecuted) {
        state.status = "failed";
        state.error = "hook-reverted";
        return { ...state };
      }
      if (faults.insufficientFee && !state.hookExecuted) {
        state.status = "failed";
        state.error = "insufficient-fee";
        return { ...state };
      }
      // Attested: mint on destination, execute hook with metadata.
      state.status = "minted";
      state.hookExecuted = true;
      state.hookMetadata = hookData;
      return { ...state };
    }
    if (state.nowSec > timeoutSec) {
      state.status = "failed";
      state.error = "poller-timeout";
    }
    return { ...state };
  }

  function runToCompletion(opts = {}) {
    let s = { ...state };
    let guard = 0;
    while (s.status === "burn_initiated" && guard++ < 100000) {
      s = poll(opts);
    }
    return s;
  }

  // Reset a transiently-failed transfer (e.g. attestation-timeout) back to
  // polling. The burn is still valid on-chain; only the poller gave up.
  function retry() {
    if (state.status === "failed" && state.error === "attestation-timeout") {
      state.status = "burn_initiated";
      state.error = null;
      return true;
    }
    return false;
  }

  return { quote: q, hookData, poll, runToCompletion, retry, state: () => ({ ...state }) };
}

// Retry wrapper: re-polls with exponential backoff on transient failures.
export function pollWithRetry(transfer, { maxAttempts = 5, baseIntervalSec = 5 } = {}) {
  let attempt = 0;
  let s = transfer.state();
  while (s.status === "burn_initiated" && attempt < maxAttempts) {
    attempt++;
    s = transfer.poll({ pollIntervalSec: baseIntervalSec * 2 ** (attempt - 1) });
    if (s.status === "failed" && s.error === "attestation-timeout") {
      // Transient: the burn is still valid on-chain; reset the poller and continue.
      transfer.retry();
      s = transfer.state();
    }
  }
  return { ...s, attempts: attempt };
}
