#!/usr/bin/env node
// SCC gate v1 (2026-10-18, F-16 / charter C-9) — shrink-only import-cycle
// baseline for server/ + src/.
//
// Version note: v1 ships with the PILOT_LIMITS leaf extraction
// (server/pilot-limits.mjs). It computes the strongly connected components
// (SCCs) of the static import graph — the same question dependency-cruiser's
// no-circular analysis answers — with zero new dependencies, in the house
// style of the other scripts/*-check.mjs gates, and compares them against
// scripts/scc-baseline.json. Gate changes are production code (fleet-tools
// rule): a baseline change must land in the same PR as the code change that
// shrinks a cycle, and is reviewed like a deploy.
//
// SHRINK-ONLY: the gate fails when a current SCC is not a subset of some
// baseline SCC — a new cycle, two baseline cycles merging, or a node joining
// an existing cycle all fail. A cycle shrinking or splitting passes (the CLI
// prints a notice; shrink the baseline in the same PR so the ratchet holds).
// The baseline must never be edited to absorb growth: growth is a finding
// to report, not a baseline to amend.
//
// Method: walk server/** and src/** for .mjs/.js; extract static import /
// export-from specifiers and string-literal dynamic import() specifiers
// from comment-stripped source; resolve relative specifiers with the
// .mjs / .js / /index fallbacks; ignore self-edges and bare specifiers;
// Tarjan SCC. `node scripts/scc-check.mjs --print` prints the measured set
// as JSON (for preparing a shrink amendment). An optional positional arg
// overrides the repo root.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Remove // and /* */ comments while preserving string/template contents
// (import specifiers are strings) and line structure.
export function stripComments(source) {
  let out = "";
  let state = null; // null | "'" | '"' | "`" | "line" | "block"
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = i + 1 < source.length ? source[i + 1] : "";
    if (state === null) {
      if (c === "/" && next === "/") { state = "line"; i++; continue; }
      if (c === "/" && next === "*") { state = "block"; i++; continue; }
      if (c === "'" || c === '"' || c === "`") state = c;
      out += c;
      continue;
    }
    if (state === "line") {
      if (c === "\n") { state = null; out += c; }
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") { state = null; i++; continue; }
      if (c === "\n") out += c;
      continue;
    }
    // string or template literal
    out += c;
    if (c === "\\" && i + 1 < source.length) { out += source[i + 1]; i++; continue; }
    if (c === state) state = null;
  }
  return out;
}

const SPECIFIER_RES = [
  /(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
  /(?<![\w$])import\s*\(\s*['"]([^'"]+)['"]/g,
];

export function extractSpecifiers(source) {
  const stripped = stripComments(source);
  const specifiers = [];
  for (const re of SPECIFIER_RES) {
    for (const m of stripped.matchAll(re)) specifiers.push(m[1]);
  }
  return specifiers;
}

function resolveSpecifier(fromPath, specifier, nodeSet) {
  if (!specifier.startsWith(".")) return null;
  const parts = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const base = parts.join("/");
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, `${base}/index.mjs`, `${base}/index.js`]) {
    if (nodeSet.has(candidate)) return candidate;
  }
  return null;
}

// sources: Map<posixPath, sourceText> -> Map<posixPath, Set<posixPath>>
export function buildGraph(sources) {
  const nodeSet = new Set(sources.keys());
  const graph = new Map();
  for (const [path, source] of sources) {
    const edges = new Set();
    for (const specifier of extractSpecifiers(source)) {
      const target = resolveSpecifier(path, specifier, nodeSet);
      if (target && target !== path) edges.add(target);
    }
    graph.set(path, edges);
  }
  return graph;
}

// Iterative Tarjan. Returns the SCCs of size > 1, plus [node] for a
// self-loop, each component sorted, the list sorted by size desc then name.
export function stronglyConnectedComponents(graph) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const result = [];
  let counter = 0;
  for (const root of [...graph.keys()].sort()) {
    if (index.has(root)) continue;
    const work = [[root, 0]];
    while (work.length) {
      const [v, childIdx] = work[work.length - 1];
      if (childIdx === 0) {
        index.set(v, counter);
        low.set(v, counter);
        counter++;
        stack.push(v);
        onStack.add(v);
      }
      const neighbours = [...(graph.get(v) ?? [])].sort();
      let recursed = false;
      for (let i = childIdx; i < neighbours.length; i++) {
        const w = neighbours[i];
        if (!index.has(w)) {
          work[work.length - 1][1] = i + 1;
          work.push([w, 0]);
          recursed = true;
          break;
        }
        if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      }
      if (recursed) continue;
      if (low.get(v) === index.get(v)) {
        const component = [];
        for (;;) {
          const w = stack.pop();
          onStack.delete(w);
          component.push(w);
          if (w === v) break;
        }
        if (component.length > 1) result.push(component.sort());
        else if ((graph.get(v) ?? new Set()).has(v)) result.push(component);
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(v)));
      }
    }
  }
  return result.sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
}

export function measureSccs(sources) {
  return stronglyConnectedComponents(buildGraph(sources));
}

// Shrink-only comparison: every current SCC must be a subset of some
// baseline SCC. Returns human-readable violations ([] = pass).
export function growthViolations(current, baseline) {
  const violations = [];
  for (const component of current) {
    const covered = baseline.some((base) => component.every((node) => base.includes(node)));
    if (!covered) {
      violations.push(
        `SCC grew beyond the baseline (${component.length} nodes): ${component.join(", ")}`
      );
    }
  }
  return violations;
}

export function collectSources(root) {
  const sources = new Map();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|js)$/.test(entry.name)) {
        sources.set(relative(root, full).split(sep).join("/"), readFileSync(full, "utf8"));
      }
    }
  };
  walk(join(root, "server"));
  walk(join(root, "src"));
  return sources;
}

export function checkSccRoot(root, baselinePath) {
  const current = measureSccs(collectSources(root));
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")).sccs;
  return { current, baseline, violations: growthViolations(current, baseline) };
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2).filter((a) => a !== "--print");
  const printOnly = process.argv.includes("--print");
  const root = args[0] ?? fileURLToPath(new URL("..", import.meta.url));
  const baselinePath = join(root, "scripts", "scc-baseline.json");
  if (printOnly) {
    console.log(JSON.stringify(measureSccs(collectSources(root)), null, 1));
    process.exit(0);
  }
  const { current, baseline, violations } = checkSccRoot(root, baselinePath);
  const currentKeys = new Set(current.map((c) => c.join("\n")));
  for (const base of baseline) {
    if (!currentKeys.has(base.join("\n"))) {
      console.log(`scc-check: notice — a baseline SCC shrank or split (shrink-only allows this; amend scripts/scc-baseline.json in this PR so the ratchet holds): ${base.join(", ")}`);
    }
  }
  if (violations.length) {
    console.error("scc-check: import cycles grew beyond the shrink-only baseline (scripts/scc-baseline.json):\n" + violations.map((v) => `  - ${v}`).join("\n"));
    console.error("scc-check: do not amend the baseline to absorb growth — break the new cycle, or report it as a finding.");
    process.exit(1);
  }
  console.log(`scc-check: ok (${current.length} SCCs, none beyond the shrink-only baseline)`);
}
