// WORKER-40 (guild-06 shard 40): perf-budget CLI usage errors must print a
// usage line to stderr and exit 2 — never exit 1 with a bare error. Follows
// the guild-06 convention (tests/guild06-usage-errors.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = `${root}/scripts/perf-budget.mjs`;

const CASES = [
  ["--bogus"],
  ["--network", "3g"],
  ["--viewport", "wide"],
  ["--pages", "about"],
  ["--origin", "file:///etc"],
  ["--out"],
  ["--cpu", "99"],
];

for (const args of CASES) {
  test(`perf-budget [${args.join(" ")}]: usage error exits 2 with Usage: on stderr`, () => {
    const r = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8", timeout: 20000, cwd: root,
    });
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /Usage:/i, "usage goes to stderr");
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
  });
}

test("perf-budget --help still prints usage to stdout and exits 0", () => {
  const r = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", timeout: 20000, cwd: root });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage:/i);
});
