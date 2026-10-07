// Game-theoretic attack-cost calculator (200-hard-tasks #25).
// Quantifies the attacks analyzed in research/FEE-REPUTATION-GAMETHEORY.md:
// Sybil (N fake identities splitting canary scrutiny), collusion rings
// (fake buyer+provider pairs washing volume), and griefing (sabotaging a
// competitor's canary rate). Closed-form + a seeded sanity sim. No I/O.
export function sybilEconomics({ honestJobsPerDay, avgJobValue, canaryRate, detectionProbPerIdentity, sybilCount, costPerIdentity }) {
  // A Sybil operator runs S identities. Each identity faces independent
  // canary scrutiny; getting caught burns that identity (lost bond + future
  // earnings). Expected profit per identity per day:
  const revenuePerIdentity = honestJobsPerDay * avgJobValue;
  const cheatGain = revenuePerIdentity * 0.2; // 20% skim via quality shading
  const pCaught = 1 - (1 - canaryRate * detectionProbPerIdentity) ** honestJobsPerDay;
  const expectedPenalty = pCaught * (costPerIdentity * 3); // bond slash + re-onboarding
  const profitPerIdentity = cheatGain - expectedPenalty - costPerIdentity / 30; // amortized daily
  return {
    sybilCount,
    pCaughtPerIdentityPerDay: +pCaught.toFixed(4),
    profitPerIdentityPerDay: +profitPerIdentity.toFixed(2),
    totalDailyProfit: +(profitPerIdentity * sybilCount).toFixed(2),
    attackProfitable: profitPerIdentity * sybilCount > 0,
  };
}

export function collusionWashTrading({ pairCount, jobsPerDay, avgJobValue, feeRate, reputationBoostValue, detectionProb }) {
  // Fake buyer+provider pairs trade with each other to inflate volume and
  // reputation. They pay the platform fee on every wash trade.
  const dailyFees = pairCount * jobsPerDay * avgJobValue * feeRate;
  const dailyRepGain = pairCount * reputationBoostValue; // monetized via better job allocation
  const pCaught = 1 - (1 - detectionProb) ** pairCount;
  const expectedPenalty = pCaught * pairCount * jobsPerDay * avgJobValue * 0.5; // slash + forfeit
  const net = dailyRepGain - dailyFees - expectedPenalty;
  return {
    dailyFeesPaid: +dailyFees.toFixed(2),
    dailyRepGain: +dailyRepGain.toFixed(2),
    pCaught: +pCaught.toFixed(4),
    netDaily: +net.toFixed(2),
    attackProfitable: net > 0,
  };
}

export function griefingEconomics({ attackerJobsPerDay, victimJobsPerDay, avgJobValue, griefCostPerJob, victimReputationLoss, attackerGainShare }) {
  // Attacker spends money to degrade a competitor (e.g. buying their
  // capacity and disputing frivolously, or spamming their endpoints).
  // The gain is diverted demand: a share of the victim's lost jobs.
  const dailyCost = attackerJobsPerDay * griefCostPerJob;
  const divertedValue = victimJobsPerDay * victimReputationLoss * avgJobValue * attackerGainShare;
  const net = divertedValue - dailyCost;
  return {
    dailyCost: +dailyCost.toFixed(2),
    divertedValue: +divertedValue.toFixed(2),
    netDaily: +net.toFixed(2),
    attackProfitable: net > 0,
  };
}

// Seeded sanity sim: run the Sybil model across canary rates to find the
// rate at which the attack turns unprofitable (the design target).
export function findBreakEvenCanaryRate(params, { lo = 0.01, hi = 0.5, steps = 49 } = {}) {
  for (let i = 0; i <= steps; i++) {
    const rate = lo + ((hi - lo) * i) / steps;
    const r = sybilEconomics({ ...params, canaryRate: rate });
    if (!r.attackProfitable) return { breakEvenCanaryRate: +rate.toFixed(3), ...r };
  }
  return { breakEvenCanaryRate: null, note: "profitable even at 50% canary rate — raise bond" };
}

const isCli = process.argv[1] && process.argv[1].endsWith("simulate-gametheory.mjs");
if (isCli) {
  const base = { honestJobsPerDay: 50, avgJobValue: 2, canaryRate: 0.05, detectionProbPerIdentity: 0.8, sybilCount: 10, costPerIdentity: 50 };
  console.log("sybil:", JSON.stringify(sybilEconomics(base)));
  console.log("breakeven:", JSON.stringify(findBreakEvenCanaryRate(base)));
  console.log("collusion:", JSON.stringify(collusionWashTrading({ pairCount: 5, jobsPerDay: 20, avgJobValue: 2, feeRate: 0.05, reputationBoostValue: 3, detectionProb: 0.02 })));
  console.log("griefing:", JSON.stringify(griefingEconomics({ attackerJobsPerDay: 10, victimJobsPerDay: 100, avgJobValue: 2, griefCostPerJob: 2.5, victimReputationLoss: 0.1, attackerGainShare: 0.3 })));
}
