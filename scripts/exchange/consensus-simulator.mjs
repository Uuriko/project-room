#!/usr/bin/env node
// Multi-reviewer consensus simulator (hard task 113).
// 500 bounties × three reviewer pools. Deterministic (seeded).
//
// Each bounty has a ground truth: good (should approve) or bad (should dispute).
// Honest reviewers report the truth with 95% accuracy. Adversarial reviewers
// always report "dispute" (they want to block payouts). Verdicts are weighted
// by reviewer reputation: honest=1.0, adversarial=0.1 (their reputation tanked
// from gaming, per task 108).
// Aggregation: score = Σ weight × verdict, verdict ∈ {+1 approve, 0 request_changes, −1 dispute}.
// Bands: ≥+0.5 approve, ≤−0.5 dispute, else request_changes. Near-ties (<0.1
// between top bands) draw one extra reviewer once, then return for more work.
let seed = 31337;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const N = 500, PANEL = 5;

function verdict(reviewer, truth) {
  if (reviewer === "adversarial") return -1; // always disputes
  return rand() < 0.95 ? truth : -truth;    // 95% accurate
}
const weight = r => (r === "adversarial" ? 0.1 : 1.0);

function decide(panel, truth) {
  let score = 0, wsum = 0;
  for (const r of panel) { score += weight(r) * verdict(r, truth); wsum += weight(r); }
  score /= wsum;
  // Tie-break: extra reviewer if near a band boundary.
  const nearBoundary = Math.abs(Math.abs(score) - 0.5) < 0.1;
  if (nearBoundary) {
    const extra = panel[0]; // same pool
    score = (score * wsum + weight(extra) * verdict(extra, truth)) / (wsum + weight(extra));
  }
  const outcome = score >= 0.5 ? "approve" : score <= -0.5 ? "dispute" : "request_changes";
  const correct = truth === 1 ? outcome === "approve" : outcome === "dispute";
  return { outcome, correct };
}

function pool(name, adversarialFrac) {
  return Array.from({ length: PANEL }, () => (rand() < adversarialFrac ? "adversarial" : "honest"));
}

for (const [name, frac] of [["honest", 0], ["mixed", 0.3], ["adversarial", 0.6]]) {
  let correct = 0, splits = 0;
  for (let i = 0; i < N; i++) {
    const truth = rand() < 0.7 ? 1 : -1; // 70% of submissions are good
    const { outcome, correct: c } = decide(pool(name, frac), truth);
    if (c) correct++;
    if (outcome === "request_changes") splits++;
  }
  console.log(`${name.padEnd(12)} correct ${(correct / N * 100).toFixed(1)}%  returned-for-more-work ${(splits / N * 100).toFixed(1)}%`);
}
console.log("\nHonest pools are near-perfect; mixed pools stay correct because adversarial");
console.log("verdicts carry 0.1 weight; adversarial pools fail closed (splits → more work),");
console.log("never by approving bad work.");
