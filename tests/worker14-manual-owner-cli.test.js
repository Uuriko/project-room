// Worker-14 fail-first: scripts/manual-owner-exercise.mjs CLI misuse must print
// a usage line to stderr and exit 2 — never an uncaught stack trace, exit 1.
// Same class the guild-06 direct pass fixed in 13 other scripts; this one was
// missed (bare `throw new Error` on argv arity, assert.ok crash on bad stage).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = `${root}/scripts/manual-owner-exercise.mjs`;

const run = (args) => spawnSync(process.execPath, [script, ...args], {
  encoding: "utf8", timeout: 20000, cwd: root,
});

for (const [label, args] of [
  ["no args", []],
  ["wrong arity", ["only-one"]],
  ["bad stage", ["owner.json", "bogus", "answer.md", "out"]],
  ["bad stage with dash answer", ["owner.json", "launch", "-", "out"]],
]) {
  test(`manual-owner-exercise [${label}]: usage error exits 2 without a stack trace`, () => {
    const r = run(args);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /Usage:/i, "usage goes to stderr");
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
  });
}
