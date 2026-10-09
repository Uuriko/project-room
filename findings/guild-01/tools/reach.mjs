// reach.mjs — reachability evidence for dead-code analysis.
// For each export of each slice module, report importers across the repo.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const ROOT = "/home/hatch/workspace/pr-wave1000-guild-01";
const SLICE = ["server/work-claims.mjs","server/work-claim-events.mjs","server/work-claim-integrity.mjs",
  "server/work-claim-mirror.mjs","server/work-claim-routes.mjs","server/work-claim-sqlite.mjs","server/claim-coordination.mjs"];
const files = [];
const walk = d => { for (const e of readdirSync(d)) { const p = join(d, e);
  if (e === "node_modules" || e === ".git" || e === ".tmp") continue;
  const s = statSync(p); if (s.isDirectory()) walk(p);
  else if (/\.(mjs|js|cjs|ts)$/.test(e)) files.push(p); } };
walk(ROOT);
const exportsOf = f => {
  const src = readFileSync(join(ROOT, f), "utf8");
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g))
    for (const n of m[1].split(",")) { const id = n.trim().split(/\s+as\s+/).pop().trim(); if (id) names.add(id); }
  return [...names];
};
for (const mod of SLICE) {
  console.log(`## ${mod}`);
  const base = mod.replace(/^server\//, "").replace(/\.mjs$/, "");
  for (const name of exportsOf(mod).sort()) {
    const users = files.filter(f => {
      if (f === join(ROOT, mod)) return false;
      const src = readFileSync(f, "utf8");
      return src.includes(name) && (src.includes(base) || /\b(import|require|from)\b/.test(src));
    }).map(f => f.replace(ROOT + "/", ""));
    // verify the file actually imports from this module
    const real = users.filter(f => {
      const src = readFileSync(join(ROOT, f), "utf8");
      return new RegExp(`from\\s+["'][^"']*${base}(\\.mjs)?["']|require\\([^)]*${base}`).test(src) || src.includes(`./${base}`);
    });
    console.log(`- ${name}: ${real.length ? real.slice(0, 8).join(", ") + (real.length > 8 ? ` (+${real.length - 8})` : "") : "NO IMPORTERS"}`);
  }
}
