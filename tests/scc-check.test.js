// SCC gate (F-16 / C-9): the shrink-only baseline in scripts/scc-baseline.json
// must hold for the real server/+src/ import graph, and the comparison must
// fail on a fixture import that grows a baseline SCC. The fixture cases run
// on in-memory source maps (buildGraph's input), so the growth failure is
// exercised exactly the way the gate computes it, with no temp tree.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildGraph,
  checkSccRoot,
  growthViolations,
  measureSccs,
  stronglyConnectedComponents,
} from "../scripts/scc-check.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("a two-module import cycle is one SCC; a chain is none", () => {
  const cyclic = new Map([
    ["src/a.js", `import { b } from "./b.js"; export const a = b;`],
    ["src/b.js", `import { a } from "./a.js"; export const b = a;`],
    ["src/c.js", `import { a } from "./a.js"; export const c = a;`],
  ]);
  assert.deepEqual(measureSccs(cyclic), [["src/a.js", "src/b.js"]]);
  const acyclic = new Map([
    ["src/a.js", `import { b } from "./b.js"; export const a = b;`],
    ["src/b.js", `export const b = 1;`],
  ]);
  assert.deepEqual(measureSccs(acyclic), []);
});

test("imports named only in comments do not create edges", () => {
  const sources = new Map([
    ["src/a.js", `// import { b } from "./b.js";\nexport const a = 1;`],
    ["src/b.js", `export const b = 1;`],
  ]);
  assert.deepEqual(measureSccs(sources), []);
});

test("shrink-only: shrinking or splitting a baseline SCC passes", () => {
  const baseline = [["src/a.js", "src/b.js", "src/c.js", "src/d.js"]];
  assert.deepEqual(growthViolations([["src/a.js", "src/b.js"]], baseline), []);
  assert.deepEqual(growthViolations([["src/a.js", "src/b.js"], ["src/c.js", "src/d.js"]], baseline), []);
  assert.deepEqual(growthViolations([], baseline), []);
});

test("shrink-only: a node joining a baseline SCC fails", () => {
  const baseline = [["src/a.js", "src/b.js"]];
  const violations = growthViolations([["src/a.js", "src/b.js", "src/c.js"]], baseline);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /src\/c\.js/);
});

test("shrink-only: a brand-new cycle and a merge of two baseline cycles fail", () => {
  const baseline = [["src/a.js", "src/b.js"], ["src/c.js", "src/d.js"]];
  assert.equal(growthViolations([["src/x.js", "src/y.js"]], baseline).length, 1);
  assert.equal(growthViolations([["src/a.js", "src/b.js", "src/c.js", "src/d.js"]], baseline).length, 1);
});

test("a fixture import that grows the baseline SCC fails the gate comparison", () => {
  // Baseline shape: a<->b cycle, c outside it.
  const before = new Map([
    ["server/a.mjs", `import { b } from "./b.mjs"; export const a = b;`],
    ["server/b.mjs", `import { a } from "./a.mjs"; export const b = a;`],
    ["server/c.mjs", `export const c = 1;`],
  ]);
  const baseline = measureSccs(before);
  assert.deepEqual(growthViolations(measureSccs(before), baseline), []);
  // Fixture: c imports a and a imports c — c joins the cycle.
  const after = new Map(before);
  after.set("server/c.mjs", `import { a } from "./a.mjs"; export const c = a;`);
  after.set("server/a.mjs", `import { b } from "./b.mjs"; import { c } from "./c.mjs"; export const a = b + c;`);
  const violations = growthViolations(measureSccs(after), baseline);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /server\/c\.mjs/);
});

test("the real tree passes the gate at the recorded baseline, exactly", (t) => {
  if (!existsSync(new URL("../server/store.mjs", import.meta.url))) {
    t.skip("real tree not present in this checkout");
    return;
  }
  const { current, baseline, violations } = checkSccRoot(root, new URL("../scripts/scc-baseline.json", import.meta.url).pathname);
  assert.deepEqual(violations, []);
  // Exact, not just subset: a shrink that landed without amending the
  // baseline fails here, so the ratchet is tightened in the same PR.
  assert.deepEqual(current, baseline);
});

test("the baseline records the two named 2-cycles from F-16", () => {
  const baseline = JSON.parse(readFileSync(new URL("../scripts/scc-baseline.json", import.meta.url), "utf8")).sccs;
  assert.ok(baseline.some((c) => c.join(",") === "server/mcp-discovery.mjs,server/mcp-http.mjs"));
  assert.ok(baseline.some((c) => c.join(",") === "src/events.js,src/work-packet.js"));
});

test("stronglyConnectedComponents is deterministic and sorted", () => {
  const graph = buildGraph(new Map([
    ["src/b.js", `import { a } from "./a.js"; export const b = a;`],
    ["src/a.js", `import { b } from "./b.js"; export const a = b;`],
  ]));
  assert.deepEqual(stronglyConnectedComponents(graph), [["src/a.js", "src/b.js"]]);
});
