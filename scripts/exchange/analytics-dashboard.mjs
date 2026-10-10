#!/usr/bin/env node
// Exchange analytics mock dashboard (hard task 111). Synthetic data.
let seed = 99;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const EPOCHS = 6;
const rows = [];
for (let e = 0; e < EPOCHS; e++) {
  const funded = 20 + Math.floor(rand() * 15);
  const paid = Math.floor(funded * (0.55 + rand() * 0.25));
  const disputed = Math.floor(paid * (0.05 + rand() * 0.12));
  const abandoned = funded - paid - Math.floor(funded * 0.05);
  rows.push({
    epoch: e + 1, funded, paid,
    fillRate: paid / funded,
    ttcDays: 2 + rand() * 6,
    ttfcHours: 4 + rand() * 40,
    reviewerAgreement: 0.7 + rand() * 0.25,
    disputeRate: disputed / Math.max(paid, 1),
    velocity: funded * (80 + rand() * 120),
    reviewerLatencyH: 12 + rand() * 60,
    abandonRate: abandoned / Math.max(funded, 1),
    budgetBurn: 0.05 + rand() * 0.15,
  });
}
const pct = x => (x * 100).toFixed(1) + "%";
console.log("BOUNTY EXCHANGE — mock dashboard (synthetic data)");
console.log("ep funded paid  fill%  ttc(d) ttfc(h) agree% disp% veloc  revLat(h) aband% burn%");
for (const r of rows) {
  console.log(
    `${String(r.epoch).padStart(2)} ${String(r.funded).padStart(6)} ${String(r.paid).padStart(4)} ` +
    `${pct(r.fillRate).padStart(6)} ${r.ttcDays.toFixed(1).padStart(6)} ${r.ttfcHours.toFixed(0).padStart(7)} ` +
    `${pct(r.reviewerAgreement).padStart(6)} ${pct(r.disputeRate).padStart(5)} ${String(Math.round(r.velocity)).padStart(6)} ` +
    `${r.reviewerLatencyH.toFixed(0).padStart(9)} ${pct(r.abandonRate).padStart(6)} ${pct(r.budgetBurn).padStart(5)}`
  );
}
const avg = k => rows.reduce((s, r) => s + r[k], 0) / rows.length;
console.log(`\n6-epoch averages: fill ${pct(avg("fillRate"))}, dispute ${pct(avg("disputeRate"))}, ` +
  `agreement ${pct(avg("reviewerAgreement"))}, budget burn ${pct(avg("budgetBurn"))} (cap 25%)`);
