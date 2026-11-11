// Tests for scripts/coverage-thresholds.mjs (backlog Q015).
//
// Authoring-gate answers:
// 1. Contract: the gate script's per-payload V8-range coverage math, the
//    cross-process union, and threshold verdicts — the CI layer that blocks
//    silent coverage decay. If this math is wrong the gate always passes and
//    decay goes undetected.
// 2. Credible regressions: merging raw ranges across processes by boundary
//    (a zero-count child from one process shadows another's positive parent —
//    adding tests lowers coverage, removing tests raises it); forgetting to
//    subtract zero-count ranges (an uncalled function inside an executed file
//    counts as covered); counting comment lines as coverable (thresholds drift
//    with comment edits); files with no coverage data ignored instead of
//    dragging the module down (a brand-new untested module never trips the
//    gate).
// 3. Nothing else covers the gate script; its inputs are pure synthetic V8
//    payloads plus one real-V8 split-process probe, so no full-suite run is
//    needed here.
// 4. No production seam: the script's exported functions are the boundary.
import test from "node:test";
import {parse} from "yaml";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverUnitTests } from "../scripts/unit-shards.mjs";

import {
  checkThresholds,
  coverageTestBatches,
  coverableLines,
  coveredLinesForPayload,
  evaluateModules,
  evaluatePayloads,
  groupFunctionsByUrl,
  lineCoverage,
  listModuleFiles,
  loadConfig,
  readCoveragePayloads,
  subtractIntervals,
} from "../scripts/coverage-thresholds.mjs";

const scriptUrl = (root, rel) => `file://${root}/${rel}`;
const payload = (url, functions) => ({ result: [{ url, functions }] });
const fn = (name, ranges) => ({ functionName: name, ranges });
const range = (start, end, count) => ({ startOffset: start, endOffset: end, count });

test("groupFunctionsByUrl keeps each payload's functions separate (no cross-process range merge)", () => {
  const url = scriptUrl("/repo", "a.mjs");
  const grouped = groupFunctionsByUrl(
    [
      payload(url, [fn("", [range(0, 50, 1)]), fn("f", [range(0, 50, 0)])]),
      payload(url, [fn("", [range(0, 50, 1)]), fn("f", [range(0, 50, 3)])]),
    ],
    "/repo"
  );
  const lists = grouped.get(url);
  assert.equal(lists.length, 2);
  // The two payloads stay distinct: callers compute coverage per payload and
  // union, instead of max-merging ranges whose boundaries may differ.
  assert.equal(lists[0].find(x => x.name === "f").ranges[0].count, 0);
  assert.equal(lists[1].find(x => x.name === "f").ranges[0].count, 3);
});

test("groupFunctionsByUrl skips non-file urls, node_modules, outside-root, and malformed payloads", () => {
  const grouped = groupFunctionsByUrl(
    [
      payload("node:internal/test", [fn("", [range(0, 10, 1)])]),
      payload(scriptUrl("/repo", "node_modules/dep/index.js"), [fn("", [range(0, 10, 1)])]),
      payload(scriptUrl("/other", "b.mjs"), [fn("", [range(0, 10, 1)])]),
      { bogus: true },
      { result: [{ url: scriptUrl("/repo", "c.mjs") }] }, // no functions key
    ],
    "/repo"
  );
  assert.equal(grouped.size, 0);
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
    const grouped = groupFunctionsByUrl(
      [payload(scriptUrl(root, "mod/covered.mjs"), [fn("", [range(0, 20, 1)])])],
      root
    );
    const results = evaluateModules(root, config, grouped);
    assert.equal(results.mod.files, 2);
    assert.equal(results.mod.coverable, 4);
    assert.equal(results.mod.covered, 1);
    assert.equal(results.mod.pct, 25);
    assert.deepEqual(results.mod.zeroCoverageFiles, ["mod/new-uncovered.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkThresholds: pct equal to threshold passes, below fails (0.1 precision)", () => {
  const config = { modules: { m: { dir: "m", threshold: 25 } } };
  const base = { dir: "m", files: 1, covered: 0, coverable: 0, zeroCoverageFiles: [], lowestFiles: [] };
  assert.equal(checkThresholds(config, { m: { ...base, pct: 25 } }).ok, true);
  const failed = checkThresholds(config, { m: { ...base, pct: 24.9 } });
  assert.equal(failed.ok, false);
  assert.equal(failed.failures[0].module, "m");
  // Floating-point epsilon: 95.64% displays as 95.6% and must pass a 95.6
  // threshold; 95.59% (floored 95.5) must fail it.
  const eps = { modules: { m: { dir: "m", threshold: 95.6 } } };
  assert.equal(checkThresholds(eps, { m: { ...base, pct: 95.64 } }).ok, true);
  assert.equal(checkThresholds(eps, { m: { ...base, pct: 95.6000001 } }).ok, true);
  assert.equal(checkThresholds(eps, { m: { ...base, pct: 95.59 } }).ok, false);
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

// Regression for the cross-process range-boundary shadowing defect: V8 range
// boundaries for the same code can differ between processes. Merging raw
// ranges by (start, end) let a zero-count child span from one process shadow
// a positive parent span from another, so adding tests could LOWER coverage.
// The fix computes coverage per payload and unions covered lines.
test("union across payloads: a zero-count span cannot shadow another payload's coverage", () => {
  const text = "a();\nb();\nc();\n";
  // Payload A: file ran, but V8 reports b()'s bytes [5,9) as one zero child.
  // Payload B: b() ran; V8 splits the same bytes as [5,7) and [7,9).
  const payloadA = [{ name: "", ranges: [{ start: 0, end: 15, count: 1 }, { start: 5, end: 9, count: 0 }] }];
  const payloadB = [
    { name: "", ranges: [{ start: 0, end: 15, count: 1 }, { start: 5, end: 7, count: 1 }, { start: 7, end: 9, count: 1 }] },
  ];
  const union = new Set([...coveredLinesForPayload(text, payloadA), ...coveredLinesForPayload(text, payloadB)]);
  assert.deepEqual([...union].sort((a, b) => a - b), [0, 1, 2]);
  // Sanity: payload A alone really does leave line 1 uncovered (the setup is
  // not vacuous).
  assert.ok(!coveredLinesForPayload(text, payloadA).has(1));
});

test("coverage is monotonic: adding a payload never reduces covered lines", () => {
  const text = "a();\nb();\nc();\nd();\n";
  const cover = lists => {
    const u = new Set();
    for (const fns of lists) for (const i of coveredLinesForPayload(text, fns)) u.add(i);
    return u;
  };
  const base = [[{ name: "", ranges: [{ start: 0, end: 20, count: 1 }, { start: 5, end: 10, count: 0 }] }]];
  const extra = [
    [{ name: "", ranges: [{ start: 0, end: 20, count: 1 }, { start: 5, end: 7, count: 1 }, { start: 7, end: 10, count: 1 }] }],
  ];
  const before = cover(base);
  const after = cover([...base, ...extra]);
  assert.ok(after.size >= before.size, `monotonicity violated: ${before.size} -> ${after.size}`);
  assert.ok(after.has(1), "newly covered line appears in the union");
});

test("real V8: split-process coverage equals single-process coverage", () => {
  // End-to-end through actual V8: the same calls run together in one process
  // vs split across two must report identical covered lines, and the union
  // must be a superset of each part.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cov-gate-v8-")));
  try {
    const mod = join(dir, "target.mjs");
    writeFileSync(mod, 'export function f(x) {\n  if (x) {\n    return "yes";\n  }\n  return "no";\n}\n');
    const run = (name, body) => {
      const script = join(dir, name);
      writeFileSync(script, body);
      const covDir = join(dir, `cov-${name}`);
      mkdirSync(covDir, { recursive: true });
      const res = spawnSync(process.execPath, [script], {
        env: { ...process.env, NODE_V8_COVERAGE: covDir },
      });
      assert.equal(res.status, 0, `script ${name} failed: ${res.stderr}`);
      return [...readCoveragePayloads(covDir)];
    };
    const together = run("both.mjs", 'import { f } from "./target.mjs"; f(true); f(false);');
    const splitA = run("a.mjs", 'import { f } from "./target.mjs"; f(true);');
    const splitB = run("b.mjs", 'import { f } from "./target.mjs"; f(false);');
    const coverTarget = payloads => {
      const grouped = groupFunctionsByUrl(payloads, dir);
      const text = readFileSync(mod, "utf8");
      const union = new Set();
      for (const fns of grouped.get(`file://${dir}/target.mjs`) || []) {
        for (const i of coveredLinesForPayload(text, fns)) union.add(i);
      }
      return union;
    };
    const config = { modules: { all: { dir: ".", threshold: 100 } } };
    for (const inputs of [together, splitA, splitB, [...splitA, ...splitB]]) {
      assert.deepEqual(evaluatePayloads(dir, config, inputs.values()).results,
        evaluateModules(dir, config, groupFunctionsByUrl(inputs, dir)),
        "streaming and grouped evaluators agree on actual V8 process payloads");
    }
    const covTogether = coverTarget(together);
    const covSplit = coverTarget([...splitA, ...splitB]);
    assert.deepEqual(
      [...covSplit].sort((a, b) => a - b),
      [...covTogether].sort((a, b) => a - b),
      "split processes must match single process"
    );
    assert.ok(covSplit.size >= coverTarget(splitA).size, "union superset of part A");
    assert.ok(covSplit.size >= coverTarget(splitB).size, "union superset of part B");
    // All six lines of target.mjs are coverable and at least the taken
    // branches are covered in both modes.
    assert.ok(covTogether.size >= 4, `expected >=4 lines, got ${covTogether.size}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The root suite executes the offline archive in actual workerd. Coverage must
// provision that same locked runtime before invoking the full test suite.
test("coverage provisions the unit job's Native archive runtime before the suite", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8"));
  const unit = workflow.jobs.unit.steps, coverage = workflow.jobs.coverage.steps;
  const required = unit.filter(step => step.uses?.startsWith("pnpm/action-setup@") || step.id === "cloudflare-modules" || step.name === "Install the Native offline-archive test runtime");
  assert.equal(required.length, 3);
  const gate = coverage.findIndex(step => step.name === "Enforce per-module coverage thresholds");
  assert.ok(gate > 0);
  for (const expected of required) {
    const index = coverage.findIndex(step => expected.id ? step.id === expected.id : expected.name ? step.name === expected.name : step.uses === expected.uses);
    assert.ok(index >= 0 && index < gate, "Native dependency setup must precede coverage: " + (expected.name ?? expected.id ?? expected.uses));
    assert.deepEqual(coverage[index], expected);
  }
});

function collectorFixture(t, failFirst = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coverage-batches-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["tests", "src", "coverage"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, "coverage", "stale.json"), JSON.stringify({ result: [] }));
  const files = ["runtime-package.test.js", "store-relief-bounded.test.js", "ordinary.test.js"];
  for (const [index, file] of files.entries()) {
    writeFileSync(join(root, "src", `part${index}.mjs`), `export const value = ${index};\n`);
    writeFileSync(join(root, "tests", file), `
      import test from 'node:test';
      import assert from 'node:assert/strict';
      import { appendFileSync } from 'node:fs';
      import { value } from '../src/part${index}.mjs';
      test('batch ${index}', () => {
        appendFileSync(${JSON.stringify(join(root, "executions.jsonl"))}, JSON.stringify({file:${JSON.stringify(file)}, runner:process.ppid, value})+${JSON.stringify("\n")});
        assert.equal(value, ${failFirst && index === 0 ? -1 : index});
      });
    `);
  }
  return { root, files };
}

function runCollectorFixture(root, inheritedContext = false) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const script = new URL("../scripts/coverage-thresholds.mjs", import.meta.url).href;
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { collectCoverage } from ${JSON.stringify(script)};
    ${inheritedContext ? 'process.env.NODE_TEST_CONTEXT="child-v8";' : ''}
    const result=collectCoverage({root:${JSON.stringify(root)}});
    process.exit(result.status);
  `], { env, encoding: "utf8", timeout: 15000 });
}

function fixtureExecutions(root) {
  return readFileSync(join(root, "executions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
}

test("collector isolates expensive files and retains real coverage from every discovered batch", t => {
  const { root, files } = collectorFixture(t);
  const result = runCollectorFixture(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const executions = fixtureExecutions(root);
  assert.deepEqual(executions.map(row => row.file).sort(), files.sort());
  assert.equal(new Set(executions.map(row => row.runner)).size, 3, "each expensive file must run alone in a separate completed runner");
  const payloads = [...readCoveragePayloads(join(root, "coverage"))];
  assert.ok(payloads.length >= 3);
  assert.ok(payloads.every(value => value.result.length > 0), "stale payload was removed before collection");
  const grouped = groupFunctionsByUrl(payloads, root);
  const config = { modules: { src: { dir: "src", threshold: 100 } } };
  const measured = evaluateModules(root, config, grouped);
  assert.equal(measured.src.files, 3);
  assert.equal(measured.src.pct, 100, "earlier batches must not be erased by a later batch");
  assert.equal(checkThresholds(config, measured).ok, true);
});

test("collector clears inherited test context and finishes later batches after a failure", t => {
  const { root, files } = collectorFixture(t, true);
  const result = runCollectorFixture(root, true);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(fixtureExecutions(root).map(row => row.file).sort(), files.sort());
  const grouped = groupFunctionsByUrl([...readCoveragePayloads(join(root, "coverage"))], root);
  assert.equal(evaluateModules(root, { modules: { src: { dir: "src", threshold: 100 } } }, grouped).src.pct, 100);
});


test("collector partitions exactly existing Node discovery with no missing or duplicate files", () => {
  const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const expected = discoverUnitTests(root);
  const batches = coverageTestBatches(root);
  assert.deepEqual(batches[0], [join(root, "tests/runtime-package.test.js")]);
  assert.deepEqual(batches[1], [join(root, "tests/store-relief-bounded.test.js")]);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.flat().sort(), expected);
  assert.equal(new Set(batches.flat()).size, expected.length);
});


test("streaming evaluator preserves grouped results across changing ranges, excludes and missing files", () => {
  const root = mkdtempSync(join(tmpdir(), "coverage-stream-parity-"));
  try {
    mkdirSync(join(root, "mod"));
    const text = "export function f(flag) {\n  if (flag) return 1;\n  return 2;\n}\n";
    writeFileSync(join(root, "mod/a.mjs"), text);
    writeFileSync(join(root, "mod/missing.mjs"), "export const missing = true;\n");
    writeFileSync(join(root, "mod/blank.mjs"), "// blank\n");
    writeFileSync(join(root, "mod/excluded.mjs"), "export const excluded = true;\n");
    const url = scriptUrl(root, "mod/a.mjs");
    const inputs = [
      payload(url, [fn("f", [range(0, text.length, 1), range(27, 50, 0)])]),
      payload(url, [fn("f", [range(0, text.length, 0)])]),
      payload(url, [fn("f", [range(0, text.length, 1), range(50, 62, 0)])]),
      payload(scriptUrl(root, "node_modules/ignore.mjs"), [fn("", [range(0, 10, 1)])]),
      { result: null },
    ];
    const config = { modules: { mod: { dir: "mod", threshold: 95, exclude: ["excluded.mjs"] }, overlapping: { dir: "mod", threshold: 100 } } };
    const expected = evaluateModules(root, config, groupFunctionsByUrl(inputs, root));
    for (const values of [inputs, inputs.toReversed(), [...inputs, ...inputs]]) {
      const actual = evaluatePayloads(root, config, values.values());
      assert.equal(actual.payloadCount, values.length);
      assert.deepEqual(actual.results, expected);
      assert.deepEqual(checkThresholds(config, actual.results), checkThresholds(config, expected));
    }
    assert.deepEqual(evaluatePayloads(root, config, []).results, evaluateModules(root, config, new Map()));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("streaming evaluator does not retain raw ranges across thousands of payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "coverage-stream-memory-"));
  try {
    mkdirSync(join(root, "mod"));
    writeFileSync(join(root, "mod/a.mjs"), "export const used = true;\n");
    const program = `
      import * as gate from ${JSON.stringify(new URL("../scripts/coverage-thresholds.mjs", import.meta.url).href)};
      const root = ${JSON.stringify(root)};
      const url = new URL('mod/a.mjs', 'file://' + root + '/').href;
      function* payloads() {
        for (let i = 0; i < 2000; i++) yield { result: [{ url, functions:
          Array.from({ length: 150 }, () => ({ functionName: 'synthetic', ranges:
            Array.from({ length: 12 }, () => ({ startOffset: 0, endOffset: 24, count: 1 })) })) }] };
      }
      const config = { modules: { mod: { dir: 'mod', threshold: 100 } } };
      const result = gate.evaluatePayloads(root, config, payloads());
      console.log(JSON.stringify(result));
    `;
    const env = { ...process.env }; delete env.NODE_V8_COVERAGE; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", program], { encoding: "utf8", env, timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const measured = JSON.parse(result.stdout.trim());
    assert.equal(measured.payloadCount, 2000);
    assert.equal(measured.results.mod.pct, 100);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
