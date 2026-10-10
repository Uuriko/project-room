// Import-closure lint hardening — task 82 (wave40-W16-import-closure-lint).
//
// The closure analyzer in scripts/runtime-import-closure.mjs feeds the
// runtime-package allowlist test: every module reachable from server.mjs
// must be registered, or createRuntimePackage ships a broken runtime.
// The analyzer's blind spots are all SILENT: dynamic import() with a
// relative literal, CommonJS require() module loads, import-attribute
// JSON modules, and relative imports that resolve to nothing are all
// dropped without a word. This file seeds each violation and pins that
// the real server tree gains zero new findings (no false positives).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  importClosure,
  importClosureReport,
  scanSourceImports,
} from "../scripts/runtime-import-closure.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));

// Seeded fixture tree: each file exercises one violation class the old
// regex-based analyzer silently dropped.
function seedFixtures(t) {
  const dir = join(tmpdir(), `import-closure-fixtures-${process.pid}`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, content) => writeFileSync(join(dir, name), content);
  mkdirSync(dir, { recursive: true });
  write("dynamic-target.mjs", "export const lazy = 1;\n");
  write("dynamic-user.mjs", "export async function load() { return import(\"./dynamic-target.mjs\"); }\n");
  write("template-user.mjs", "export async function load(name) { return import(`./mods/${name}.mjs`); }\n");
  write("require-target.cjs", "module.exports = { legacy: true };\n");
  write("require-user.cjs", "const legacy = require(\"./require-target.cjs\");\nmodule.exports = { legacy };\n");
  write("assert-require.cjs", "function check(x) { require(x > 0); require(typeof x === \"number\" && x < 10); }\nmodule.exports = { check };\n");
  write("data.json", "{ \"seed\": true }\n");
  write("json-user.mjs", "import data from \"./data.json\" with { type: \"json\" };\nexport default data;\n");
  write("missing-user.mjs", "import \"./does-not-exist.mjs\";\nexport const broken = 1;\n");
  write("prose.mjs", "// uses dynamic import() for lazily loaded routes\nconst meta = import.meta.url;\nexport const ok = true;\n");
  write("root.mjs", [
    "export * from \"./dynamic-user.mjs\";",
    "export * from \"./template-user.mjs\";",
    "export * from \"./json-user.mjs\";",
    "export * from \"./missing-user.mjs\";",
    "export * from \"./prose.mjs\";",
    "",
  ].join("\n"));
  return dir;
}

test("dynamic import() with a relative literal is followed into the closure", t => {
  const dir = seedFixtures(t);
  const report = importClosureReport("root.mjs", dir);
  assert.ok(report.closure.has("dynamic-target.mjs"),
    "dynamic import('./dynamic-target.mjs') must be followed, not silently dropped");
});

test("dynamic import() with a template specifier is reported as opaque, not dropped", t => {
  const dir = seedFixtures(t);
  const report = importClosureReport("root.mjs", dir);
  assert.ok(report.opaque.some(entry => entry.from === "template-user.mjs"),
    `template dynamic imports must be flagged opaque, got: ${JSON.stringify(report.opaque)}`);
});

test("CommonJS require() module loads are followed; assertion-style require() is ignored", t => {
  const dir = seedFixtures(t);
  const report = importClosureReport("require-user.cjs", dir);
  assert.ok(report.closure.has("require-target.cjs"),
    "require('./require-target.cjs') module loads must be followed");
  const assertOnly = scanSourceImports(
    "function check(x) { require(x > 0); require(typeof x === \"number\"); }\n");
  assert.deepEqual(assertOnly.relative, [],
    "assertion-style require(cond) must not produce module deps");
});

test("JSON modules imported with attributes are followed", t => {
  const dir = seedFixtures(t);
  const report = importClosureReport("root.mjs", dir);
  assert.ok(report.closure.has("data.json"),
    "import './data.json' with { type: 'json' } must be followed");
});

test("relative imports that resolve to nothing are reported, not silently skipped", t => {
  const dir = seedFixtures(t);
  const report = importClosureReport("root.mjs", dir);
  assert.ok(report.unresolvable.some(entry => entry.spec === "./does-not-exist.mjs"),
    `missing modules must be reported unresolvable, got: ${JSON.stringify(report.unresolvable)}`);
});

test("prose mentions of import() and import.meta are not module imports", t => {
  const dir = seedFixtures(t);
  const report = importClosureReport("prose.mjs", dir);
  assert.deepEqual([...report.closure], []);
  assert.deepEqual(report.opaque, []);
  assert.deepEqual(report.unresolvable, []);
});

test("zero false positives: the real server.mjs closure is unchanged and clean", () => {
  const baselinePath = join(repository, "tests", "fixtures", "import-closure", "server-closure-baseline.json");
  const report = importClosureReport("server.mjs", repository);
  if (process.env.UPDATE_IMPORT_CLOSURE_BASELINE === "1") {
    writeFileSync(baselinePath, JSON.stringify([...report.closure].sort(), null, 2) + "\n");
    console.log(`baseline regenerated: ${report.closure.size} modules`);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  assert.deepEqual([...report.closure].sort(), baseline,
    "hardened analyzer must not add or drop any module on the real server tree " +
    "(if main legitimately gained/lost a module, regenerate with UPDATE_IMPORT_CLOSURE_BASELINE=1)");
  assert.deepEqual(report.opaque, [],
    `no opaque dynamic imports on main, got: ${JSON.stringify(report.opaque)}`);
  assert.deepEqual(report.unresolvable, [],
    `no unresolvable relative imports on main, got: ${JSON.stringify(report.unresolvable)}`);
  // The legacy entry point keeps its shape for tests/runtime-package.test.js.
  const legacy = importClosure("server.mjs", repository);
  assert.ok(legacy instanceof Set);
  assert.deepEqual([...legacy].sort(), baseline);
});
