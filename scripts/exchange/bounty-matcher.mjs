#!/usr/bin/env node
// Bounty-matching prototype (hard task 114). 50 bounties × 10 profiles.
let seed = 5150;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = arr => arr[Math.floor(rand() * arr.length)];

const SKILLS = ["rust", "typescript", "python", "docs", "design", "research", "testing", "security", "devops", "copywriting"];
const CATS = ["bug fix", "docs", "test coverage", "research", "design", "operations"];

const bounties = Array.from({ length: 50 }, (_, i) => {
  const skills = [...new Set([pick(SKILLS), pick(SKILLS)])];
  return {
    id: `b${i + 1}`,
    title: `${pick(CATS)}: ${skills.join(" + ")} task #${i + 1}`,
    skills,
    price: pick([25, 50, 75, 100, 150, 200, 250, 400, 500]),
    ageDays: Math.floor(rand() * 20),
    minRep: rand() < 0.2 ? 600 : 0,
  };
});

const profiles = Array.from({ length: 10 }, (_, i) => ({
  id: `c${i + 1}`,
  skills: [...new Set([pick(SKILLS), pick(SKILLS), pick(SKILLS)])],
  priceLo: 25, priceHi: pick([100, 200, 500]),
  rep: 300 + Math.floor(rand() * 600),
}));

function jaccard(a, b) {
  const s = new Set(b);
  const inter = a.filter(x => s.has(x)).length;
  return inter / new Set([...a, ...b]).size;
}

function score(b, p) {
  if (p.rep < b.minRep) return { total: 0, parts: null }; // filtered out
  const skill = jaccard(b.skills, p.skills);
  if (skill === 0) return { total: 0, parts: null }; // no shared skills: not recommended
  const priceFit = b.price >= p.priceLo && b.price <= p.priceHi ? 1
    : Math.max(0, 1 - Math.min(Math.abs(b.price - p.priceLo), Math.abs(b.price - p.priceHi)) / 500);
  const freshness = Math.max(0, 1 - b.ageDays / 14);
  const repFit = b.minRep === 0 ? 1 : Math.min(1, p.rep / (b.minRep * 1.5));
  const total = skill * 0.5 + priceFit * 0.25 + freshness * 0.15 + repFit * 0.10;
  return { total, parts: { skill, priceFit, freshness, repFit } };
}

for (const p of profiles) {
  const ranked = bounties
    .map(b => ({ b, ...score(b, p) }))
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 3);
  console.log(`\n${p.id} skills=[${p.skills}] price≤${p.priceHi} rep=${p.rep}`);
  for (const r of ranked) {
    const { skill, priceFit, freshness, repFit } = r.parts;
    console.log(`  ${r.b.id} ${r.total.toFixed(2)} ${r.b.title} ${r.b.price}cr ` +
      `(skill ${skill.toFixed(2)}, price ${priceFit.toFixed(2)}, fresh ${freshness.toFixed(2)}, rep ${repFit.toFixed(2)})`);
  }
}

// Sanity check: a pure-rust contributor should never see copywriting bounties.
const rustDev = { id: "rust-dev", skills: ["rust", "devops", "testing"], priceLo: 25, priceHi: 500, rep: 800 };
const bad = bounties.filter(b => b.skills.includes("copywriting") && !b.skills.some(s => rustDev.skills.includes(s)));
const leaked = bad.filter(b => score(b, rustDev).total > 0.4);
console.log(`\nsanity: ${bad.length} copywriting-only bounties, ${leaked.length} ranked >0.4 for a rust dev ${leaked.length === 0 ? "✔" : "✖"}`);
