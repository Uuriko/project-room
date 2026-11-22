import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSyntax } from "../scripts/syntax-check.mjs";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "room-syntax-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test("syntax validation accepts modules without executing their side effects", async t => {
  const cwd = fixture(t);
  const source = 'import { writeFileSync } from "node:fs"; writeFileSync("executed", "yes"); await Promise.resolve(); throw new Error("must not execute"); export const value = 1;';
  const paths = Array.from({ length: 8 }, (_, i) => `valid-${i}.mjs`);
  for (const path of paths) writeFileSync(join(cwd, path), source);
  assert.equal(await checkSyntax(paths, { cwd, stdio: "ignore" }), 0);
  assert.equal(existsSync(join(cwd, "executed")), false);
});

test("invalid syntax fails with sequential and bounded parallel validation", async t => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, "valid.mjs"), "export const value = 1;");
  writeFileSync(join(cwd, "invalid.mjs"), "export const broken = ;");
  for (const concurrency of [1, 4]) {
    assert.notEqual(await checkSyntax(["valid.mjs", "invalid.mjs", "valid.mjs"], { cwd, concurrency, stdio: "ignore" }), 0);
  }
});

test("missing source and child startup failure cannot pass validation", async t => {
  const cwd = fixture(t);
  assert.notEqual(await checkSyntax(["missing.mjs"], { cwd, stdio: "ignore" }), 0);
  assert.notEqual(await checkSyntax(["missing.mjs"], { cwd: join(cwd, "missing-directory"), stdio: "ignore" }), 0);
});

test("empty input succeeds and concurrency is bounded", async () => {
  assert.equal(await checkSyntax([]), 0);
  for (const concurrency of [0, 5, 1.5, NaN]) {
    await assert.rejects(checkSyntax([], { concurrency }), RangeError);
  }
});

// The in-process parser must keep `node --check`'s source-type rule:
// .mjs is a module, .cjs is a script, .js follows the nearest
// package.json "type" (a package.json without "type" is CommonJS).
test("source type follows extension and package scope like node --check", async t => {
  const cwd = fixture(t);
  for (const [scope, manifest] of [["mod", { type: "module" }], ["cjs", { type: "commonjs" }], ["plain", {}]]) {
    mkdirSync(join(cwd, scope));
    writeFileSync(join(cwd, scope, "package.json"), JSON.stringify(manifest));
  }
  writeFileSync(join(cwd, "mod", "esm.js"), "export const x = 1;\n");
  writeFileSync(join(cwd, "mod", "ret.mjs"), "return 1;\n");
  writeFileSync(join(cwd, "cjs", "ret.cjs"), "return 1;\n");
  writeFileSync(join(cwd, "cjs", "ret.js"), "return;\n");
  writeFileSync(join(cwd, "cjs", "esm.cjs"), "import fs from 'node:fs';\n");
  writeFileSync(join(cwd, "plain", "ret.js"), "return;\n");
  writeFileSync(join(cwd, "plain", "esm.js"), "export const x = 1;\n");
  assert.equal(await checkSyntax(["mod/esm.js"], { cwd, stdio: "ignore" }), 0);
  assert.notEqual(await checkSyntax(["mod/ret.mjs"], { cwd, stdio: "ignore" }), 0);
  assert.equal(await checkSyntax(["cjs/ret.cjs"], { cwd, stdio: "ignore" }), 0);
  assert.equal(await checkSyntax(["cjs/ret.js"], { cwd, stdio: "ignore" }), 0);
  assert.notEqual(await checkSyntax(["cjs/esm.cjs"], { cwd, stdio: "ignore" }), 0);
  assert.equal(await checkSyntax(["plain/ret.js"], { cwd, stdio: "ignore" }), 0);
  assert.notEqual(await checkSyntax(["plain/esm.js"], { cwd, stdio: "ignore" }), 0);
});

// Differential pins vs `node --check` (PERF-50 G-S2): the early-error
// classes the spawning stage caught must still be caught in-process,
// and the valid edge syntax it accepted must still be accepted.
test("in-process verdicts match node --check on seeded edge cases", async t => {
  const cwd = fixture(t);
  const valid = [
    "await Promise.resolve();\nexport {};",
    "import j from './x.json' with { type: 'json' };",
    "#!/usr/bin/env node\nconsole.log(1);",
    "using r = { [Symbol.dispose]() {} };",
    "class A { #x = 1; static { this.y = 2; } m() { return this.#x; } }",
    "const a = 10 / 2; const re = /a{1,2}[b-c]\\/d/gi;",
    "const n = 1_000_000n + 0b1010n;",
  ];
  const broken = [
    "export const broken = ;",
    "export function f() {\n  return 1;",
    "const a = 1; const a = 2;",
    "function f(a, a) { return a; }",
    "return 1;",
    "with (obj) { f(); }",
    "const x = 0755;",
    "const c = 1; export { c as a }; export const a = 2;",
    "1 = 2;",
    "let x = 1; delete x;",
    "break foo;",
    "const o = { __proto__: 1, __proto__: 2 };",
    "const re = /[/;",
    "const re = /x/gg;",
    "const re = /(?P<x>a)/;",
    "class A { m() { return this.#x; } }",
    "class A { #x = 1; #x = 2; }",
    "import j from './x.json' assert { type: 'json' };",
    "yield 1;",
    "const t = new.target;",
  ];
  for (const [index, source] of valid.entries()) {
    const path = `valid-edge-${index}.mjs`;
    writeFileSync(join(cwd, path), source);
    assert.equal(await checkSyntax([path], { cwd, stdio: "ignore" }), 0, `valid case ${index} rejected: ${source}`);
  }
  for (const [index, source] of broken.entries()) {
    const path = `broken-edge-${index}.mjs`;
    writeFileSync(join(cwd, path), source);
    assert.notEqual(await checkSyntax([path], { cwd, stdio: "ignore" }), 0, `broken case ${index} accepted: ${source}`);
  }
});

test("a rejected file is reported with path, line and SyntaxError", async t => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, "invalid.mjs"), "export const broken = ;");
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    assert.notEqual(await checkSyntax(["invalid.mjs"], { cwd }), 0);
  } finally {
    console.error = original;
  }
  const report = lines.join("\n");
  assert.match(report, /invalid\.mjs:1/);
  assert.match(report, /SyntaxError: Unexpected token/);
});
