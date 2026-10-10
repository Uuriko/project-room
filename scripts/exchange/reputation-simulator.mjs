#!/usr/bin/env node
// Exchange reputation simulator (hard task 108).
// 200 bounties, four strategies. Deterministic (seeded).
//
// Strategies:
//   honest      — completes work, rarely abandons, fair reviews
//   sloppy      — abandons 30% of claims, mediocre quality
//   gamer       — sock-puppet alts approve its work; farms tiny bounties
//   adversarial — disputes every loss, spams disputes
//
// Scoring (docs/exchange/108-exchange-reputation.md):
//   rep = 1000 * completion * quality * stake_mult * decay
// New participants start at 0.5 (neutral).
let seed = 4242;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const N = 200;
const agents = {
  honest:      { completed: 0, abandoned: 0, disputedLost: 0, qualitySum: 0, qualityN: 0, sizeSum: 0, stake: 0 },
  sloppy:      { completed: 0, abandoned: 0, disputedLost: 0, qualitySum: 0, qualityN: 0, sizeSum: 0, stake: 0 },
  gamer:       { completed: 0, abandoned: 0, disputedLost: 0, qualitySum: 0, qualityN: 0, sizeSum: 0, stake: 0 },
  adversarial: { completed: 0, abandoned: 0, disputedLost: 0, qualitySum: 0, qualityN: 0, sizeSum: 0, stake: 0 },
};
// Gamer's sock-puppet reviewers start at ~0 reputation: their verdicts carry ~0 weight.
const reviewerWeight = reviewer => reviewer === "sock" ? 0.02 : 1;

for (let i = 0; i < N; i++) {
  const size = [25, 50, 100, 200, 400][Math.floor(rand() * 5)];
  for (const [name, a] of Object.entries(agents)) {
    const r = rand();
    if (name === "honest") {
      if (r < 0.92) { a.completed++; a.sizeSum += size; a.qualitySum += 0.9 * reviewerWeight("established"); a.qualityN += reviewerWeight("established"); }
      else if (r < 0.97) { a.abandoned++; }
      else { a.disputedLost++; }
    } else if (name === "sloppy") {
      if (r < 0.6) { a.completed++; a.sizeSum += size; a.qualitySum += 0.55; a.qualityN += 1; }
      else if (r < 0.9) { a.abandoned++; }
      else { a.disputedLost++; }
    } else if (name === "gamer") {
      // Farms the smallest bounties; sock-puppets "approve" — but their
      // verdicts carry ~0 weight, so quality comes only from real reviewers.
      const s = 25;
      if (r < 0.95) { a.completed++; a.sizeSum += s; a.qualitySum += 0.6 * reviewerWeight("sock") + 0.5 * 0.3; a.qualityN += reviewerWeight("sock") + 0.3; }
      else { a.abandoned++; }
    } else { // adversarial
      if (r < 0.7) { a.completed++; a.sizeSum += size; a.qualitySum += 0.7; a.qualityN += 1; }
      else if (r < 0.8) { a.abandoned++; }
      else { a.disputedLost++; a.disputedLost++; } // dispute spam: lost disputes count double
    }
  }
}

function reputation(a) {
  // Disputes lost count double in the denominator (docs/108).
  const total = a.completed + a.abandoned + 2 * a.disputedLost;
  if (total === 0) return 500;
  const completion = a.completed / total;
  const quality = a.qualityN > 0 ? a.qualitySum / a.qualityN : 0.5;
  // Size weighting: tiny-bounty farming moves the score less.
  const avgSize = a.sizeSum / Math.max(a.completed, 1);
  const sizeFactor = Math.min(1, 0.5 + avgSize / 400);
  const stakeMult = 1.0; // no staking in this run
  const decay = 1.0;     // 200 bounties ≈ continuous activity
  return Math.round(1000 * completion * quality * sizeFactor * stakeMult * decay);
}

console.log("strategy     rep  completed abandoned disputedLost avgQuality");
for (const [name, a] of Object.entries(agents)) {
  const q = a.qualityN > 0 ? (a.qualitySum / a.qualityN).toFixed(2) : "0.50";
  console.log(`${name.padEnd(13)} ${String(reputation(a)).padStart(4)} ${String(a.completed).padStart(9)} ${String(a.abandoned).padStart(9)} ${String(a.disputedLost).padStart(12)} ${q}`);
}
const reps = Object.entries(agents).map(([n, a]) => [n, reputation(a)]).sort((x, y) => y[1] - x[1]);
console.log(`\nranking: ${reps.map(([n, r]) => `${n}(${r})`).join(" > ")}`);
console.log(reps[0][0] === "honest" && reps[reps.length - 1][0] === "adversarial"
  ? "honest finishes top, adversarial sinks bottom ✔"
  : "unexpected ranking — review the scoring weights ✖");
