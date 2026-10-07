// Canary sampling simulator (200-hard-tasks #23).
// Statistical canary re-execution: sample s of jobs, re-run on trusted
// hardware, compare outputs. A cheating provider cheats on fraction f of
// jobs; each sampled cheat is caught by the comparison with probability d.
// P(catch >= 1 cheat in N jobs) = 1 - (1 - s*f*d)^N.
// Seeded RNG => deterministic runs for tests and reports.
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

// Closed-form detection probability.
export function detectionProbability({ jobs, sampleRate, cheatRate, detectProb = 1 }) {
  for (const [k, v] of Object.entries({ jobs, sampleRate, cheatRate, detectProb })) {
    if (!(v >= 0)) throw new Error(`detectionProbability: ${k} must be >= 0`);
  }
  if (sampleRate > 1 || cheatRate > 1 || detectProb > 1) {
    throw new Error("detectionProbability: rates must be <= 1");
  }
  const p = sampleRate * cheatRate * detectProb;
  if (p === 0) return 0;
  return 1 - Math.pow(1 - p, jobs);
}

// Jobs needed for detection probability >= target.
export function jobsForDetection({ sampleRate, cheatRate, detectProb = 1, target = 0.99 }) {
  const p = sampleRate * cheatRate * detectProb;
  if (p <= 0) return Infinity;
  if (p >= 1) return 1;
  return Math.ceil(Math.log(1 - target) / Math.log(1 - p));
}

// Cost overhead as a fraction of normal job spend: sampling s of jobs at
// trustedCostMult x the provider's per-job cost.
export function costOverhead({ sampleRate, trustedCostMult = 2 }) {
  return sampleRate * trustedCostMult;
}

// Monte Carlo: empirical P(caught) over `trials` runs of `jobs` jobs.
export function simulate({ jobs, sampleRate, cheatRate, detectProb = 1, trials = 2000, seed = 42 }) {
  const rand = mulberry32(seed);
  let caught = 0;
  let cheatsSeen = 0;
  let samplesTaken = 0;
  for (let t = 0; t < trials; t++) {
    let trialCaught = false;
    for (let j = 0; j < jobs; j++) {
      const cheated = rand() < cheatRate;
      if (!cheated) continue;
      cheatsSeen++;
      if (rand() >= sampleRate) continue;
      samplesTaken++;
      if (rand() < detectProb) trialCaught = true;
    }
    if (trialCaught) caught++;
  }
  return {
    trials,
    jobs,
    sampleRate,
    cheatRate,
    detectProb,
    empiricalDetection: caught / trials,
    closedForm: detectionProbability({ jobs, sampleRate, cheatRate, detectProb }),
    avgCheatsPerTrial: cheatsSeen / trials,
    avgSamplesPerTrial: samplesTaken / trials,
  };
}

// Sweep sample rates for a fixed cheater; returns the cheapest rate hitting
// the target detection probability within `jobs` jobs.
export function recommendRate({ cheatRate, detectProb = 1, jobs, target = 0.99, trustedCostMult = 2 }) {
  for (const s of [0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3, 0.5]) {
    if (detectionProbability({ jobs, sampleRate: s, cheatRate, detectProb }) >= target) {
      return { sampleRate: s, overhead: costOverhead({ sampleRate: s, trustedCostMult }), jobs, target };
    }
  }
  return { sampleRate: 1, overhead: trustedCostMult, jobs, target, note: "even 50% sampling misses the target; increase jobs or improve comparison" };
}
