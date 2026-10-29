// CI gate: the store import cycle may only shrink (SIMPLIFY-2026-10 §6,
// deep-pass S-01). A static Tarjan walk over the server-only import graph
// (relative imports only — the same method as the cluster-03 L01 census,
// which measured the 39-module SCC at 927a642029) finds the strongly
// connected component containing server/store.mjs and ratchets it against
// scripts/store-scc-baseline.json:
//
//   - a module joining the store SCC that is not in the pinned member set
//     fails (SCC growth);
//   - an import edge between two store-SCC members that is not in the
//     pinned edge set fails (re-tangling inside the component);
//   - any server module importing { ServiceError } from store.mjs fails
//     (§6 step 1 is finished: ServiceError lives in the leaf module
//     server/service-error.mjs, which store.mjs re-exports; importing it
//     from store.mjs is the back edge this programme removed).
//
// Shrinking is always allowed and is the point: when the SCC or its edge
// set gets smaller, regenerate the pin with --print-baseline and commit
// the smaller baseline in the same change. Never grow the baseline to
// make a red gate pass — that is the re-tangling this gate exists to stop.
//
// Usage: node scripts/check-store-scc.mjs [--root <dir>] [--baseline <file>]
//        node scripts/check-store-scc.mjs --print-baseline
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const root = resolve(argValue("--root") || process.cwd());
const baselinePath = argValue("--baseline")
  ? resolve(argValue("--baseline"))
  : join(root, "scripts", "store-scc-baseline.json");
const printBaseline = args.includes("--print-baseline");

const serverDir = join(root, "server");
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(mjs|js)$/.test(e.name)) files.push(p);
  }
};
walk(serverDir);
const rel = (p) => relative(root, p).split("\\").join("/");
const fileSet = new Set(files.map(rel));
const edges = new Map([...fileSet].map((f) => [f, new Set()]));
const importFromRe = /(?:^|\n)\s*(?:import|export)\b[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const sideEffectRe = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const namedImportRe = /import\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

const resolveLocal = (fromFile, spec) => {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(join(root, fromFile)), spec);
  for (const cand of [base, `${base}.mjs`, `${base}.js`, join(base, "index.mjs"), join(base, "index.js")]) {
    const r = rel(cand);
    if (fileSet.has(r)) return r;
  }
  return null;
};

const serviceErrorFromStore = [];
for (const f of fileSet) {
  const src = readFileSync(join(root, f), "utf8");
  const specs = new Set();
  for (const re of [importFromRe, sideEffectRe]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) specs.add(m[1]);
  }
  for (const s of specs) {
    const t = resolveLocal(f, s);
    if (t) edges.get(f).add(t);
  }
  // §6 step-1 leg: match named imports on comment-stripped source so prose
  // (e.g. the explanation comment inside store.mjs itself) is never read
  // as an import.
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  namedImportRe.lastIndex = 0;
  let m;
  while ((m = namedImportRe.exec(stripped))) {
    const names = m[1].split(",").map((s) => s.trim());
    if (!names.some((n) => /^ServiceError(\s+as\s+[\w$]+)?$/.test(n))) continue;
    if (resolveLocal(f, m[2]) === "server/store.mjs") serviceErrorFromStore.push(f);
  }
}

// Tarjan SCC (recursive; the server graph is ~400 modules, well inside the
// default stack, and this exact shape reproduced the L01 census counts).
let counter = 0;
const index = new Map(), low = new Map(), onStack = new Set(), stack = [], sccs = [];
const strongconnect = (v) => {
  index.set(v, counter); low.set(v, counter); counter++;
  stack.push(v); onStack.add(v);
  for (const w of edges.get(v)) {
    if (!index.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
  }
  if (low.get(v) === index.get(v)) {
    const comp = [];
    let w;
    do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
    sccs.push(comp);
  }
};
for (const v of fileSet) if (!index.has(v)) strongconnect(v);

const storeScc = sccs.find((c) => c.includes("server/store.mjs")) || ["server/store.mjs"];
const members = [...storeScc].sort();
const memberSet = new Set(members);
const intraEdges = [];
for (const u of members) for (const v of edges.get(u)) if (memberSet.has(v)) intraEdges.push(`${u} -> ${v}`);
intraEdges.sort();

if (printBaseline) {
  console.log(JSON.stringify({
    description: "Ratchet pin for the store.mjs strongly connected component (scripts/check-store-scc.mjs). Members and intra-component edges may only shrink; regenerate with: node scripts/check-store-scc.mjs --print-baseline",
    members,
    edges: intraEdges,
  }, null, 2));
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const pinnedMembers = new Set(baseline.members);
const pinnedEdges = new Set(baseline.edges);
const failures = [];
for (const f of serviceErrorFromStore.sort()) {
  failures.push(`${f}: imports { ServiceError } from store.mjs — import it from server/service-error.mjs instead (§6 step 1)`);
}
for (const m of members) {
  if (!pinnedMembers.has(m)) failures.push(`store SCC growth: ${m} joined the store component (not in the pinned baseline)`);
}
for (const e of intraEdges) {
  if (!pinnedEdges.has(e)) failures.push(`store SCC re-tangle: new intra-component edge ${e} (not in the pinned baseline)`);
}

if (failures.length) {
  console.error("store SCC gate failed:\n" + failures.join("\n"));
  process.exit(1);
}
console.log(`store SCC pinned: ${members.length} modules, ${intraEdges.length} intra-component edges (baseline ${pinnedMembers.size} modules, ${pinnedEdges.size} edges) — no growth, no ServiceError imports from store.mjs`);
