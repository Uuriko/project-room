// Dispute-resolution simulator (200-hard-tasks #18).
// Full flow: escrow funded -> dispute opened -> evidence window (both
// sides submit) -> arbiter ruling -> payout / refund / split / penalty.
// Evidence items carry { side, kind, weight }; the arbiter scores each
// side with credibility multipliers (signed artifacts outrank bare claims)
// and rules by margin. Seeded; no I/O.
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

// Credibility multipliers by evidence kind. Signed, verifiable artifacts
// dominate: a bare "I delivered" claim is worth a tenth of a signed receipt.
export const CREDIBILITY = Object.freeze({
  "signed-receipt": 1.0,
  "delivery-proof": 0.9, // hash-linked output the buyer can re-verify
  "canary-record": 0.9, // server-side canary pass/fail log
  "signed-statement": 0.6, // signed but self-serving
  "unsigned-claim": 0.1,
  "third-party-log": 0.7,
});

export const RULINGS = Object.freeze(["provider-wins", "buyer-wins", "split", "provider-penalized"]);

export function createDispute({ disputeId, jobId, envelopeId, amountRaw, openedBy, reason, seed = 1 }) {
  if (!["buyer", "provider"].includes(openedBy)) throw new Error("openedBy must be buyer|provider");
  const rand = mulberry32(seed);
  const evidence = [];
  const state = {
    disputeId, jobId, envelopeId, amountRaw: String(amountRaw),
    status: "evidence-window",
    openedBy, reason,
    evidence,
    ruling: null,
  };

  function submitEvidence({ side, kind, weight, detail = "" }) {
    if (state.status !== "evidence-window") throw new Error(`cannot submit evidence while ${state.status}`);
    if (!["buyer", "provider"].includes(side)) throw new Error("side must be buyer|provider");
    if (!CREDIBILITY[kind]) throw new Error(`unknown evidence kind: ${kind}`);
    if (!(weight > 0)) throw new Error("weight must be > 0");
    evidence.push({ side, kind, weight, detail, credibility: CREDIBILITY[kind] });
    return evidence.length;
  }

  function scoreSide(side) {
    return evidence.filter((e) => e.side === side).reduce((s, e) => s + e.weight * e.credibility, 0);
  }

  // Ruling logic (documented in research/DISPUTE-RESOLUTION.md):
  // score each side; the margin decides. A no-show (zero credible evidence
  // from the respondent) forfeits; a narrow margin splits.
  function rule({ splitThreshold = 0.25, forfeitThreshold = 0.05 } = {}) {
    if (state.status !== "evidence-window") throw new Error(`already ruled: ${state.ruling?.ruling}`);
    const buyerScore = scoreSide("buyer");
    const providerScore = scoreSide("provider");
    const total = buyerScore + providerScore;
    let ruling, buyerShareBps, providerShareBps, penaltyBps = 0;

    if (total === 0) {
      // No evidence at all: refund the buyer; nothing was proven.
      ruling = "buyer-wins"; buyerShareBps = 10000; providerShareBps = 0;
    } else if (providerScore <= total * forfeitThreshold && buyerScore > 0) {
      // Provider no-show: buyer refunded AND provider penalized (stake slash).
      ruling = "provider-penalized"; buyerShareBps = 10000; providerShareBps = 0; penaltyBps = 1000;
    } else if (buyerScore <= total * forfeitThreshold && providerScore > 0) {
      // Buyer opened a frivolous dispute and submitted nothing: provider paid.
      ruling = "provider-wins"; buyerShareBps = 0; providerShareBps = 10000;
    } else {
      const margin = Math.abs(providerScore - buyerScore) / total;
      if (margin < splitThreshold) {
        ruling = "split"; buyerShareBps = 5000; providerShareBps = 5000;
      } else if (providerScore > buyerScore) {
        ruling = "provider-wins"; buyerShareBps = 0; providerShareBps = 10000;
      } else {
        ruling = "buyer-wins"; buyerShareBps = 10000; providerShareBps = 0;
      }
    }

    const amount = BigInt(state.amountRaw);
    state.status = "resolved";
    state.ruling = {
      ruling, buyerScore: +buyerScore.toFixed(3), providerScore: +providerScore.toFixed(3),
      buyerShareBps, providerShareBps, penaltyBps,
      buyerPayoutRaw: ((amount * BigInt(buyerShareBps)) / 10000n).toString(),
      providerPayoutRaw: ((amount * BigInt(providerShareBps)) / 10000n).toString(),
      penaltyRaw: ((amount * BigInt(penaltyBps)) / 10000n).toString(),
    };
    return { ...state.ruling };
  }

  return { submitEvidence, rule, scoreSide, state: () => ({ ...state, evidence: [...evidence] }) };
}

// --- Scripted scenarios (each demonstrates the full flow) ---

export function scenarioNonDeliveryWithProof(seed = 11) {
  // Buyer claims non-delivery; provider produces a signed receipt + delivery proof. Provider wins.
  const d = createDispute({ disputeId: "d1", jobId: "job-d1", envelopeId: "env_d1", amountRaw: "100000", openedBy: "buyer", reason: "never received output", seed });
  d.submitEvidence({ side: "buyer", kind: "unsigned-claim", weight: 1, detail: "says nothing arrived" });
  d.submitEvidence({ side: "provider", kind: "signed-receipt", weight: 1, detail: "Ed25519 receipt for job-d1" });
  d.submitEvidence({ side: "provider", kind: "delivery-proof", weight: 1, detail: "output hash matches job manifest" });
  return d.rule();
}

export function scenarioGarbageDelivery(seed = 22) {
  // Provider delivered garbage; buyer has server-side canary records. Buyer wins.
  const d = createDispute({ disputeId: "d2", jobId: "job-d2", envelopeId: "env_d2", amountRaw: "100000", openedBy: "buyer", reason: "output failed quality checks", seed });
  d.submitEvidence({ side: "buyer", kind: "canary-record", weight: 1, detail: "3/3 canary probes failed" });
  d.submitEvidence({ side: "buyer", kind: "third-party-log", weight: 0.5, detail: "gateway logged malformed output" });
  d.submitEvidence({ side: "provider", kind: "signed-statement", weight: 1, detail: "claims output was fine" });
  return d.rule();
}

export function scenarioAmbiguousQuality(seed = 33) {
  // Both sides have plausible evidence; margin is narrow. Split.
  const d = createDispute({ disputeId: "d3", jobId: "job-d3", envelopeId: "env_d3", amountRaw: "100000", openedBy: "buyer", reason: "output partially usable", seed });
  d.submitEvidence({ side: "buyer", kind: "unsigned-claim", weight: 1, detail: "half the outputs were wrong" });
  d.submitEvidence({ side: "buyer", kind: "third-party-log", weight: 0.5, detail: "gateway logged partial failures" });
  d.submitEvidence({ side: "provider", kind: "signed-statement", weight: 1, detail: "outputs match spec; buyer misconfigured" });
  return d.rule();
}

export function scenarioProviderNoShow(seed = 44) {
  // Provider never responds to the dispute. Buyer refunded + provider penalized.
  const d = createDispute({ disputeId: "d4", jobId: "job-d4", envelopeId: "env_d4", amountRaw: "100000", openedBy: "buyer", reason: "provider vanished", seed });
  d.submitEvidence({ side: "buyer", kind: "unsigned-claim", weight: 1, detail: "no output, no response" });
  return d.rule();
}

export function runAllScenarios() {
  return {
    nonDeliveryWithProof: scenarioNonDeliveryWithProof(),
    garbageDelivery: scenarioGarbageDelivery(),
    ambiguousQuality: scenarioAmbiguousQuality(),
    providerNoShow: scenarioProviderNoShow(),
  };
}

const isCli = process.argv[1] && process.argv[1].endsWith("simulate-disputes.mjs");
if (isCli) {
  const all = runAllScenarios();
  for (const [name, r] of Object.entries(all)) {
    console.log(`${name}: ruling=${r.ruling} buyer=${r.buyerPayoutRaw} provider=${r.providerPayoutRaw} penalty=${r.penaltyRaw} (scores b=${r.buyerScore} p=${r.providerScore})`);
  }
}
