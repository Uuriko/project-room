// Tests for scripts/coverage-thresholds.mjs (backlog Q015).
//
// Authoring-gate answers:
// 1. Contract: the gate script's V8-range merge math and threshold verdicts —
//    the CI layer that blocks silent coverage decay. If this math is wrong the
//    gate always passes and decay goes undetected.
// 2. Credible regressions: merging counts with min instead of max (a line run
//    in one test process counts as uncovered); forgetting to subtract
//    zero-count ranges (an uncalled function inside an executed file counts as
//    covered); counting comment lines as coverable (thresholds drift with
//    comment edits); files with no coverage data ignored instead of dragging
//    the module down (a brand-new untested module never trips the gate).
// 3. Nothing else covers the gate script; its inputs are pure synthetic V8
//    payloads, so no full-suite run is needed here.
// 4. No production seam: the script's exported functions are the boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkThresholds,
  coverableLines,
  evaluateModules,
  lineCoverage,
  listModuleFiles,
  loadConfig,
  mergeCoverage,
  readCoveragePayloads,
  subtractIntervals,
} from "../scripts/coverage-thresholds.mjs";

const scriptUrl = (root, rel) => `file://${root}/${rel}`;
const payload = (url, functions) => ({ result: [{ url, functions }] });
const fn = (name, ranges) => ({ functionName: name, ranges });
const range = (start, end, count) => ({ startOffset: start, endOffset: end, count });

test("mergeCoverage takes the max count per range across payloads", () => {
  const url = scriptUrl("/repo", "a.mjs");
  const merged = mergeCoverage(
    [
      payload(url, [fn("", [range(0, 50, 1)]), fn("f", [range(0, 50, 0)])]),
      payload(url, [fn("", [range(0, 50, 1)]), fn("f", [range(0, 50, 3)])]),
    ],
    "/repo"
  );
  const f = merged.get(url).functions.find(x => x.name === "f");
  assert.equal(f.ranges.find(r => r.start === 0 && r.end === 50).count, 3);
});

test("mergeCoverage skips non-file urls, node_modules, outside-root, and malformed payloads", () => {
  const merged = mergeCoverage(
    [
      payload("node:internal/test", [fn("", [range(0, 10, 1)])]),
      payload(scriptUrl("/repo", "node_modules/dep/index.js"), [fn("", [range(0, 10, 1)])]),
      payload(scriptUrl("/other", "b.mjs"), [fn("", [range(0, 10, 1)])]),
      { bogus: true },
      { result: [{ url: scriptUrl("/repo", "c.mjs") }] }, // no functions key
    ],
    "/repo"
  );
  assert.equal(merged.size, 1);
  assert.ok(merged.has(scriptUrl("/repo", "c.mjs")));
});

test("subtractIntervals removes zero-count cuts from covered spans", () => {
  assert.deepEqual(subtractIntervals([[0, 100]], [[20, 30]]), [[0, 20], [30, 100]]);
  assert.deepEqual(subtractIntervals([[0, 10]], [[0, 10]]), []);
  assert.deepEqual(subtractIntervals([[0, 10]], [[20, 30]]), [[0, 10]]);
  assert.deepEqual(subtractIntervals([], [[0, 10]]), []);
});

test("coverableLines excludes blanks and comment-only lines", () => {
  const text = [
    "// leading comment",
    "",
    "code();",
    "code2(); // trailing comment stays coverable",
    "/* block open",
    " * continuation",
    " close */",
    "code3();",
    "/* inline */ code4();",
  ].join("\n");
  assert.deepEqual(coverableLines(text), [false, false, true, true, false, false, false, true, true]);
});

test("lineCoverage: uncalled function inside an executed file counts as uncovered", () => {
  // The top-level range covers the whole file (count 1), but `unused` was
  // never called (count 0): its line must not count as covered via the
  // `export ` prefix bytes that sit outside the function's own span.
  const text = "export function add(a, b) { return a + b; }\nexport function unused(x) { return x * 2; }\n";
  const functions = [
    { name: "", ranges: [{ start: 0, end: 88, count: 1 }] },
    { name: "add", ranges: [{ start: 7, end: 43, count: 1 }] },
    { name: "unused", ranges: [{ start: 51, end: 87, count: 0 }] },
  ];
  const lc = lineCoverage(text, functions);
  assert.equal(lc.coverable, 2);
  assert.equal(lc.covered, 1);
  assert.deepEqual(lc.uncoveredLines, [2]);
});

test("lineCoverage: untaken inner block inside a called function counts as uncovered", () => {
  const text = "function f(x) {\n  if (x) { return 1; }\n  return 2;\n}\nf(true);\n";
  // Whole function ran; the `return 2;` statement block never did. The zero
  // range covers the statement's code bytes, so leading whitespace on the
  // line must not rescue it.
  const functions = [
    { name: "", ranges: [{ start: 0, end: 61, count: 1 }] },
    { name: "f", ranges: [{ start: 0, end: 52, count: 1 }, { start: 41, end: 50, count: 0 }] },
  ];
  const lc = lineCoverage(text, functions);
  assert.equal(lc.coverable, 5);
  assert.equal(lc.covered, 4);
  assert.deepEqual(lc.uncoveredLines, [3]);
});

test("lineCoverage: no ranges means zero covered; no coverable lines means 100%", () => {
  assert.equal(lineCoverage("a();\nb();\n", []).covered, 0);
  const empty = lineCoverage("// only a comment\n\n", [{ start: 0, end: 5, count: 1 }]);
  assert.equal(empty.coverable, 0);
  assert.equal(empty.pct, 100);
});

test("listModuleFiles picks up source and skips tests, checks, and node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "cov-gate-files-"));
  try {
    mkdirSync(join(root, "mod", "node_modules", "dep"), { recursive: true });
    for (const f of ["a.mjs", "b.js", "c.cjs", "a.test.js", "b.check.mjs", "node_modules/dep/d.js"]) {
      writeFileSync(join(root, "mod", f), "export {};\n");
    }
    const files = listModuleFiles(root, "mod", ["-fixture.mjs"]);
    assert.deepEqual(files, ["mod/a.mjs", "mod/b.js", "mod/c.cjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluateModules: a file with no coverage data drags the module down", () => {
  const root = mkdtempSync(join(tmpdir(), "cov-gate-eval-"));
  try {
    mkdirSync(join(root, "mod"), { recursive: true });
    writeFileSync(join(root, "mod", "covered.mjs"), "export const x = 1;\n");
    writeFileSync(join(root, "mod", "new-uncovered.mjs"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
    const config = { modules: { mod: { dir: "mod", threshold: 50 } } };
    const merged = mergeCoverage(
      [payload(scriptUrl(root, "mod/covered.mjs"), [fn("", [range(0, 20, 1)])])],
      root
    );
    const results = evaluateModules(root, config, merged);
    assert.equal(results.mod.files, 2);
    assert.equal(results.mod.coverable, 4);
    assert.equal(results.mod.covered, 1);
    assert.equal(results.mod.pct, 25);
    assert.deepEqual(results.mod.zeroCoverageFiles, ["mod/new-uncovered.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkThresholds: pct equal to threshold passes, below fails", () => {
  const config = { modules: { m: { dir: "m", threshold: 25 } } };
  const base = { dir: "m", files: 1, covered: 0, coverable: 0, zeroCoverageFiles: [], lowestFiles: [] };
  assert.equal(checkThresholds(config, { m: { ...base, pct: 25 } }).ok, true);
  const failed = checkThresholds(config, { m: { ...base, pct: 24.9 } });
  assert.equal(failed.ok, false);
  assert.equal(failed.failures[0].module, "m");
});

test("loadConfig validates shape", () => {
  const root = mkdtempSync(join(tmpdir(), "cov-gate-cfg-"));
  try {
    mkdirSync(join(root, "mod"), { recursive: true });
    const write = (name, obj) => {
      const p = join(root, name);
      writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
      return p;
    };
    const good = { version: 1, modules: { mod: { dir: "mod", threshold: 10 } } };
    const cfg = p => loadConfig(p, root);
    assert.doesNotThrow(() => cfg(write("good.json", good)));
    assert.throws(() => cfg(write("bad.json", "{oops")), /not valid JSON/);
    assert.throws(
      () => cfg(write("no-threshold.json", { modules: { mod: { dir: "mod" } } })),
      /threshold/
    );
    assert.throws(
      () => cfg(write("bad-range.json", { modules: { mod: { dir: "mod", threshold: 101 } } })),
      /threshold/
    );
    assert.throws(
      () => cfg(write("no-dir.json", { modules: { mod: { dir: "nope", threshold: 10 } } })),
      /does not exist/
    );
    assert.throws(() => cfg(join(root, "missing.json")), /not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readCoveragePayloads streams one payload at a time and tolerates truncated files", () => {
  const dir = mkdtempSync(join(tmpdir(), "cov-gate-payloads-"));
  try {
    writeFileSync(join(dir, "coverage-1.json"), JSON.stringify({ result: [] }));
    writeFileSync(join(dir, "coverage-2.json"), "{truncated");
    writeFileSync(join(dir, "notes.txt"), "not json");
    const payloads = [...readCoveragePayloads(dir)];
    assert.equal(payloads.length, 1);
    assert.deepEqual(payloads[0], { result: [] });
    assert.deepEqual([...readCoveragePayloads(join(dir, "nope"))], []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig reads the real repo config", () => {
  const config = loadConfig(new URL("../coverage-thresholds.json", import.meta.url));
  assert.ok(Object.keys(config.modules).length > 0);
  for (const mod of Object.values(config.modules)) {
    assert.ok(typeof mod.threshold === "number");
  }
});
