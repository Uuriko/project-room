// Guild-06 worker-50 fail-first: numeric options (--threshold/--fail-under/--top)
// with a missing, non-numeric, or flag-like value must fail clean — stderr +
// exit 2 — instead of silently scoring with NaN or swallowing the next flag
// as the value (e.g. `--fail-under --json` ate --json and printed text).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = `${root}/scripts/lesson-scorer.mjs`;
const NO_STACK = /^\s*at\s/m;

const run = (args) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 30000, cwd: root });

const badCases = [
  ["--threshold"], ["--threshold", "--json"], ["--threshold", "abc"], ["--threshold", "NaN"],
  ["--fail-under"], ["--fail-under", "--json"], ["--fail-under", "nope"],
  ["--top"], ["--top", "--json"], ["--top", "xyz"],
];

for (const args of badCases) {
  test(`lesson-scorer.mjs ${args.join(" ")}: usage error exits 2, no silent NaN`, () => {
    const r = run(args);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /numeric|Usage/i, "clean error on stderr");
    assert.doesNotMatch(r.stderr, NO_STACK, "no stack trace");
    assert.doesNotMatch(r.stdout, /entries scored/, "must not print a report on bad args");
  });
}

test("lesson-scorer.mjs valid numeric options still work", () => {
  const r = run(["--threshold", "50", "--top", "3", "--json"]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr.slice(0, 300)}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.threshold, 50);
  assert.ok(parsed.entries.length <= 3, "top N is honored");
});
