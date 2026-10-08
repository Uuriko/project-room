// verify:affected picks the unit tests related to a diff. Each test names the
// observable selection rule it guards; the fixture repo is in memory.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseImports,
  resolveSpecifier,
  buildReverseGraph,
  relatedTests,
  selectTests,
  SMOKE_TESTS,
} from "../scripts/verify-affected.mjs";

const repo = {
  "server/core.mjs": `export const x = 1;`,
  "server/feature.mjs": `import { x } from "./core.mjs";\nexport const y = x;`,
  "server/lazy.mjs": `export async function f() { return import("./feature.mjs"); }`,
  "server/orphan.mjs": `export const z = 3;`,
  "tests/feature.test.js": `import { y } from "../server/feature.mjs";`,
  "tests/core.test.js": `import { x } from "../server/core";`,
  "tests/lazy.test.js": `const m = await import("../server/lazy.mjs");`,
  "tests/docs.test.js": `const spec = readFileSync(new URL("../docs/openapi.yaml", import.meta.url));`,
  "tests/mention.test.js": `const p = "docs/guide.md"; read("README.md");`,
  "tests/prose.test.js": `// see README.md for details`,
  "tests/slow.test.js": `import "../server/feature.mjs";`,
  "docs/openapi.yaml": "openapi: 3.1.0",
  "docs/guide.md": "# guide",
  "README.md": "# readme",
  [SMOKE_TESTS[0]]: "",
};
const files = Object.keys(repo);
const read = (f) => repo[f];
const tests = files.filter((f) => f.startsWith("tests/"));
const reverse = buildReverseGraph(files, read);

test("parseImports reads static, re-export, dynamic, require and new URL specifiers", () => {
  const src = [
    `import a from "./a.mjs";`,
    `import { b } from '../b.js';`,
    `import "./side.mjs";`,
    `export * from "./re.mjs";`,
    `const c = await import("./c.mjs");`,
    `const d = require("./d.cjs");`,
    `new URL("../e.json", import.meta.url)`,
    `import fs from "node:fs";`,
  ].join("\n");
  assert.deepEqual(new Set(parseImports(src)), new Set(["./a.mjs", "../b.js", "./side.mjs", "./re.mjs", "./c.mjs", "./d.cjs", "../e.json", "node:fs"]));
});

test("resolveSpecifier resolves relative paths with or without extension and ignores bare ones", () => {
  const known = new Set(files);
  assert.equal(resolveSpecifier("tests/core.test.js", "../server/core", known), "server/core.mjs");
  assert.equal(resolveSpecifier("server/feature.mjs", "./core.mjs", known), "server/core.mjs");
  assert.equal(resolveSpecifier("server/feature.mjs", "node:fs", known), null);
  assert.equal(resolveSpecifier("server/feature.mjs", "./missing.mjs", known), null);
  assert.equal(resolveSpecifier("server/feature.mjs", "../../outside.mjs", known), null);
});

test("a change selects direct and transitive importers with their distance", () => {
  const hit = relatedTests({ changed: ["server/core.mjs"], tests, reverse, read });
  assert.equal(hit.get("tests/core.test.js").distance, 1);
  assert.equal(hit.get("tests/feature.test.js").distance, 2);
  assert.equal(hit.get("tests/lazy.test.js").distance, 3, "literal dynamic import is an edge");
  assert.equal(hit.has("tests/docs.test.js"), false);
});

test("non-code files map through new URL() references and path mentions", () => {
  const hit = relatedTests({ changed: ["docs/openapi.yaml", "docs/guide.md"], tests, reverse, read });
  assert.ok(hit.has("tests/docs.test.js"));
  assert.equal(hit.get("tests/mention.test.js").via, "mentions docs/guide.md");
  assert.equal(hit.has("tests/feature.test.js"), false);

  const root = relatedTests({ changed: ["README.md"], tests, reverse, read });
  assert.ok(root.has("tests/mention.test.js"), "quoted root file name");
  assert.equal(root.has("tests/prose.test.js"), false, "bare root file name in prose");
});

test("closest tests win the budget; changed tests are always kept", () => {
  const timings = { "tests/core.test.js": 1000, "tests/feature.test.js": 1000, "tests/lazy.test.js": 1000, "tests/slow.test.js": 500000 };
  const { selected, skipped } = selectTests({ changed: ["server/core.mjs"], tests, reverse, read, timings, budgetMs: 2500 });
  assert.deepEqual(selected.map((s) => s.test), ["tests/core.test.js", "tests/feature.test.js"]);
  assert.deepEqual(new Set(skipped.map((s) => s.test)), new Set(["tests/lazy.test.js", "tests/slow.test.js"]));

  const kept = selectTests({ changed: ["tests/slow.test.js"], tests, reverse, read, timings, budgetMs: 1 });
  assert.deepEqual(kept.selected.map((s) => s.test), ["tests/slow.test.js"]);
});

test("unmapped code, global files and empty diffs fall back to the smoke set", () => {
  const smoke = (changed) => selectTests({ changed, tests, reverse, read, budgetMs: 1e9 });
  const orphan = smoke(["server/orphan.mjs"]);
  assert.match(orphan.smokeReasons.join(), /no related test for server\/orphan\.mjs/);
  assert.ok(orphan.selected.some((s) => s.via === "smoke" && s.test === SMOKE_TESTS[0]));
  assert.deepEqual(smoke(["package.json"]).smokeReasons, ["global file changed"]);
  assert.deepEqual(smoke([]).smokeReasons, ["no changes"]);
  assert.deepEqual(smoke(["server/core.mjs"]).smokeReasons, [], "mapped code needs no smoke set");
});
