// Provider reputation simulator (200-hard-tasks #24).
// Dasha-owned reputation: score in [0,1] from canary pass rate, latency p99,
// uptime, and dispute outcomes, with exponential decay so recent behavior
// dominates. Seeded RNG => deterministic trajectories for tests and reports.
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

export const DEFAULT_WEIGHTS = Object.freeze({
  canary: 0.55, // canary pass rate (quality) — applied CONVEX (rate^2): cheating is punished superlinearly
  latency: 0.15, // p99 latency vs SLO
  uptime: 0.15, // successful jobs / total jobs
  disputes: 0.15, // 1 - lost-dispute rate
});
export const DECAY = 0.995; // per-job exponential decay of accumulated stats
export const LATENCY_SLO_MS = 8000;

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

export function createReputation(weights = DEFAULT_WEIGHTS) {
  let w = { ...weights };
  // Accumulated (decayed) stats.
  let s = { canaryPass: 1, canaryTotal: 1, latencyOver: 0, latencyTotal: 1, ok: 1, total: 1, disputesLost: 0, disputesTotal: 1 };

  function observe({ canary = null, latencyMs = null, success = true, dispute = null }) {
    for (const k of Object.keys(s)) s[k] *= DECAY;
    if (canary !== null) {
      s.canaryTotal += 1;
      if (canary) s.canaryPass += 1;
    }
    if (latencyMs !== null) {
      s.latencyTotal += 1;
      if (latencyMs > LATENCY_SLO_MS) s.latencyOver += 1;
    }
    s.total += 1;
    if (success) s.ok += 1;
    if (dispute === "won" || dispute === "lost") {
      // disputesTotal counts EVERY dispute (won or lost); only losses hurt.
      s.disputesTotal += 1;
      if (dispute === "lost") s.disputesLost += 1;
    }
  }

  function score() {
    const canaryRate = s.canaryPass / s.canaryTotal;
    const latencyRate = 1 - s.latencyOver / s.latencyTotal;
    const uptime = s.ok / s.total;
    const disputeRate = 1 - s.disputesLost / s.disputesTotal;
    // Convex canary term: a 30% cheat rate (rate 0.7) contributes 0.45*0.49,
    // not 0.45*0.7 — cheating is punished superlinearly so it cannot hide
    // behind perfect latency/uptime.
    return clamp01(
      w.canary * canaryRate * canaryRate + w.latency * latencyRate + w.uptime * uptime + w.disputes * disputeRate
    );
  }

  function components() {
    return {
      canaryRate: s.canaryPass / s.canaryTotal,
      latencyRate: 1 - s.latencyOver / s.latencyTotal,
      uptime: s.ok / s.total,
      disputeRate: 1 - s.disputesLost / s.disputesTotal,
    };
  }

  return { observe, score, components };
}

// Provider archetypes for the trajectory simulation.
export const ARCHETYPES = {
  honest: { cheatRate: 0, p99LatencyMs: 3000, failRate: 0.005, disputeRaiseRate: 0.002, disputeLossRate: 0 },
  flaky: { cheatRate: 0.02, p99LatencyMs: 12000, failRate: 0.08, disputeRaiseRate: 0.05, disputeLossRate: 0.05 },
  malicious: { cheatRate: 0.3, p99LatencyMs: 4000, failRate: 0.02, disputeRaiseRate: 0.5, disputeLossRate: 0.4 },
};

// Simulate `jobs` jobs for one archetype; sample `canaryRate` of jobs.
export function simulateProvider(archetype, { jobs = 1000, canaryRate = 0.05, seed = 1, snapshotEvery = 100 } = {}) {
  const a = ARCHETYPES[archetype];
  if (!a) throw new Error(`unknown archetype: ${archetype}`);
  const rand = mulberry32(seed);
  const rep = createReputation();
  const trajectory = [{ job: 0, score: rep.score() }];
  for (let j = 1; j <= jobs; j++) {
    const cheated = rand() < a.cheatRate;
    const success = rand() >= a.failRate;
    const latencyMs = a.p99LatencyMs * (0.3 + rand() * 1.4);
    const sampled = rand() < canaryRate;
    // Disputes: raised more often when the provider cheated; lost at disputeLossRate.
    let dispute = null;
    if (rand() < (cheated ? a.disputeRaiseRate : a.disputeRaiseRate * 0.1)) {
      dispute = rand() < a.disputeLossRate ? "lost" : "won";
    }
    rep.observe({
      canary: sampled ? !cheated : null, // comparison catches cheats (d~1 for the sim)
      latencyMs,
      success,
      dispute,
    });
    if (j % snapshotEvery === 0) trajectory.push({ job: j, score: +rep.score().toFixed(4) });
  }
  return { archetype, finalScore: +rep.score().toFixed(4), components: rep.components(), trajectory };
}

export function routingTier(score) {
  if (score >= 0.9) return "preferred"; // full traffic
  if (score >= 0.75) return "standard"; // normal traffic
  if (score >= 0.55) return "probation"; // reduced traffic + elevated canary sampling
  return "suspended"; // no traffic until manual review
}
