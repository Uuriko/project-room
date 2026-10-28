import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildReport, buildImportGraph, formatMarkdown } from "../scripts/server-coverage-report.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function fixture(t) {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const dir = mkdtempSync(join(root, ".tmp", "tst10-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const server = join(dir, "server");
  const tests = join(dir, "tests");
  mkdirSync(join(server, "sub"), { recursive: true });
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(server, "a.mjs"), 'import { b } from "./b.mjs";\nexport const a = () => b;\n');
  writeFileSync(join(server, "b.mjs"), 'export { c } from "./sub/c.mjs";\nexport const b = 1;\n');
  writeFileSync(join(server, "sub", "c.mjs"), "export const c = 1;\n");
  writeFileSync(join(server, "lazy.mjs"), 'export const l = () => import("./orphan.mjs");\n');
  writeFileSync(join(server, "orphan.mjs"), "export const o = 1;\n");
  writeFileSync(join(server, "island.mjs"), "export const i = 1;\n");
  writeFileSync(join(tests, "a.test.js"), 'import { a } from "../server/a.mjs";\n');
  return { dir, server, tests };
}

test("TST-10: import graph follows static, re-export and dynamic relative imports", t => {
  const { server } = fixture(t);
  const g = buildImportGraph(server, ["a.mjs", "b.mjs", "sub/c.mjs", "lazy.mjs", "orphan.mjs", "island.mjs"]);
  assert.deepEqual(g.get("a.mjs"), ["b.mjs"]);
  assert.deepEqual(g.get("b.mjs"), ["sub/c.mjs"]);
  assert.deepEqual(g.get("lazy.mjs"), ["orphan.mjs"]);
  assert.deepEqual(g.get("island.mjs"), []);
});

test("TST-10: report splits direct, transitive and unreached modules", t => {
  const { dir, server, tests } = fixture(t);
  const r = buildReport({ root: dir, serverDir: server, testDir: tests });
  const status = Object.fromEntries(r.rows.map(x => [x.module, x.status]));
  assert.deepEqual(status, {
    "a.mjs": "direct", "b.mjs": "transitive", "sub/c.mjs": "transitive",
    "island.mjs": "unreached", "lazy.mjs": "unreached", "orphan.mjs": "unreached"
  });
  assert.deepEqual(r.totals, { modules: 6, direct: 1, transitive: 2, unreached: 3 });
  assert.deepEqual(r.rows.find(x => x.module === "b.mjs").importedBy, ["a.mjs"]);
  const md = formatMarkdown(r, { revision: "abc1234" });
  assert.match(md, /Unreached: no test loads these modules \(3\)/);
  assert.match(md, /\| b\.mjs \| a\.mjs \|/);
});

test("TST-10: --coverage-dir adds per-file line coverage unioned across processes", t => {
  const { dir, server, tests } = fixture(t);
  const cov = join(dir, "cov");
  mkdirSync(cov);
  const url = pathToFileURL(join(server, "a.mjs")).href;
  // Process 1 runs line 1 only; process 2 runs line 2 only. The union covers both.
  const text = 'import { b } from "./b.mjs";\nexport const a = () => b;\n';
  const l1 = text.indexOf("\n");
  writeFileSync(join(cov, "coverage-1.json"), JSON.stringify({ result: [{ url, functions: [{ functionName: "", ranges: [{ startOffset: 0, endOffset: text.length, count: 1 }, { startOffset: l1 + 1, endOffset: text.length, count: 0 }] }] }] }));
  writeFileSync(join(cov, "coverage-2.json"), JSON.stringify({ result: [{ url, functions: [{ functionName: "", ranges: [{ startOffset: 0, endOffset: text.length, count: 1 }, { startOffset: 0, endOffset: l1, count: 0 }] }] }] }));
  const r = buildReport({ root: dir, serverDir: server, testDir: tests, coverageDir: cov });
  assert.deepEqual(r.rows.find(x => x.module === "a.mjs").coverage, { covered: 2, coverable: 2, pct: 100 });
  assert.equal(r.rows.find(x => x.module === "island.mjs").coverage.pct, 0);
});

test("TST-10: the repo has no unreached server modules", () => {
  const r = buildReport({ root });
  assert.deepEqual(r.rows.filter(x => x.status === "unreached").map(x => x.module), []);
});
