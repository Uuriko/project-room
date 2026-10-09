// Worker-39 (guild-06) fail-first: report-unit-failures.mjs must fail CLEAN on
// CLI misuse — stderr usage + exit 2, never a raw stack trace or a silently
// accepted unknown flag. Guild-06 usage-error convention.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (args, env = {}) =>
  spawnSync(process.execPath, [`${root}/scripts/report-unit-failures.mjs`, ...args], {
    encoding: "utf8", timeout: 20000, cwd: root, env: { ...process.env, ...env },
  });

const BAD = [
  ["--shard=garbage"],
  ["--shard=1/5"],
  ["--shard=0/3"],
  ["--shard=4/3"],
  ["--shard==1/3"],
  ["--bogus", "--shard=1/3"],
  ["--shard=1/3", "--bogus"],
  ["--body-file"], // missing value
];

for (const args of BAD) {
  test(`misuse [${args.join(" ")}] exits 2 with usage, no stack trace`, () => {
    const r = run(args);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /Usage:/i, "usage goes to stderr");
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
    assert.equal(r.stdout, "", "no body emitted on misuse");
  });
}

test("--shard=2/3 still succeeds with an empty failure list", () => {
  const r = run(["--shard=2/3"]);
  assert.equal(r.status, 0, r.stderr.slice(0, 300));
  assert.match(r.stdout, /^## Unit test failures, shard 2\/3/);
});

test("--body-file writes the comment body", () => {
  const dir = mkdtempSync(join(tmpdir(), "ruf-"));
  const bodyFile = join(dir, "comment.md");
  const r = run(["--shard=1/3", `--body-file=${bodyFile}`]);
  assert.equal(r.status, 0, r.stderr.slice(0, 300));
  assert.match(readFileSync(bodyFile, "utf8"), /^## Unit test failures, shard 1\/3/);
});
