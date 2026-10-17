import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
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
