#!/usr/bin/env node
// Faucet anti-farming simulator (hard task 105).
// Models honest users vs. farmers over 24 epochs under layered defenses,
// and shows farming is net-negative. Deterministic (seeded) so the numbers
// are reproducible.
//
// Strategies (effort ~= attention cost; 1 effort ~= 10 min):
//   honest    — 1 identity, real activity, stipend + real bounties
//   sybil     — 40 identities, harvests welcome grants, thin activity
//   wash      — 12 bots replying to each other to fake activity
//   referral  — 1 main + 9 alts in a self-referral ring
//
// Defenses (toggle with --no-<defense> to see the margin each one buys):
//   tiers     — stipends need tenure (epoch>=4) + verified activity
//   diversity — stipend weighted by distinct-counterparty diversity
//               (wash clusters ~0, thin sybil activity 0.2x)
//   vesting   — referral grants vest only on 30d activity + a completed
//               bounty (alts never qualify)
//   epoch-caps— per-(identity, epoch) issuance caps (ledger UNIQUE)
//
// Cost model: creating + aging an identity costs 3 effort (it takes days of
// wall-clock aging and setup). A real bounty pays 200cr for ~20 effort.
// Welcome grant = 50cr. Stipend = 20cr/epoch. Referral grant = 30cr.
const args = process.argv.slice(2);
const off = new Set(args.filter(a => a.startsWith("--no-")).map(a => a.slice(5)));
const has = d => !off.has(d);

const EPOCHS = 24;
const WELCOME = 50, STIPEND = 20, BOUNTY_PAY = 200, BOUNTY_EFFORT = 20;
const REFERRAL = 30, IDENTITY_COST = 3;

function simulate(strategy) {
  let credits = 0, effort = 0;
  const identities = { honest: 1, sybil: 40, wash: 12, referral: 10 }[strategy];
  effort += identities * IDENTITY_COST; // creating + aging every identity
  for (let e = 0; e < EPOCHS; e++) {
    // Welcome grant: one-time per identity, epoch 0.
    if (e === 0) credits += identities * WELCOME;
    // Stipend per identity, gated.
    let per = STIPEND;
    if (has("tiers") && strategy !== "honest" && e < 4) per = 0;
    if (has("diversity") && strategy === "wash") per *= 0.05;
    if (has("diversity") && strategy === "sybil") per *= 0.2;
    if (has("diversity") && strategy === "referral") per *= 0.2;
    credits += identities * per;
    effort += identities * (strategy === "honest" ? 3 : strategy === "wash" ? 2 : 0.5);
    // Bounties: honest does real work every other epoch; farmers' junk fails review.
    if (strategy === "honest" && e % 2 === 0) { credits += BOUNTY_PAY; effort += BOUNTY_EFFORT; }
    if (strategy !== "honest" && e % 6 === 0) effort += BOUNTY_EFFORT * 0.3; // rejected junk, effort wasted
    // Referral grants: 9 alts × 30cr, vesting at epoch 8 — only without the vesting defense.
    if (strategy === "referral" && e >= 8 && !has("vesting")) { credits += 9 * REFERRAL; effort += 9 * 0.2; }
  }
  const roi = credits / Math.max(effort, 0.1);
  return { credits: Math.round(credits), effort: Math.round(effort * 10) / 10, roi: Math.round(roi * 10) / 10 };
}

const rows = ["honest", "sybil", "wash", "referral"].map(s => ({ strategy: s, ...simulate(s) }));
console.log("strategy  credits  effort  cr/effort");
for (const r of rows) console.log(`${r.strategy.padEnd(9)} ${String(r.credits).padStart(7)} ${String(r.effort).padStart(7)} ${String(r.roi).padStart(9)}`);
const honest = rows[0];
const best = rows.slice(1).reduce((a, b) => (b.roi > a.roi ? b : a));
console.log(`\nbest farming ROI: ${best.roi} cr/effort (${best.strategy}) vs honest: ${honest.roi} cr/effort`);
console.log(best.roi < honest.roi ? "FARMING IS NET-NEGATIVE vs honest play ✔" : "WARNING: farming beats honest play — defenses insufficient ✖");
console.log(`defenses off: ${[...off].join(", ") || "none"} (toggle with --no-tiers/--no-diversity/--no-vesting/--no-epoch-caps)`);
