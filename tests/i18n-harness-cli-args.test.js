// Worker-33 (guild-06 shard 33): fail-first regression for the i18n-harness
// CLI-argument bug — unknown options and conflicting modes must fail loudly
// (stderr usage, exit 2), never silently run the default --check.
//
// Repro (before fix):
//   node scripts/i18n-harness.mjs --bogus   -> exit 0, prints "i18n-harness OK"
//   node scripts/i18n-harness.mjs --help    -> exit 0, prints "i18n-harness OK"
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const harness = `${root}/scripts/i18n-harness.mjs`;

const run = (args) =>
  spawnSync(process.execPath, [harness, ...args], { encoding: "utf8", timeout: 60000, cwd: root });

for (const args of [["--bogus"], ["--help"], ["--check", "--bogus"], ["--extract", "--check"], ["-x"]]) {
  test(`i18n-harness [${args.join(" ")}]: unknown/conflicting args exit 2 with usage on stderr`, () => {
    const r = run(args);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stdout: ${r.stdout.slice(0, 200)} stderr: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /Usage:/i, "usage goes to stderr");
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
  });
}

test("i18n-harness --check still exits 0 (valid control)", () => {
  const r = run(["--check"]);
  assert.equal(r.status, 0, `--check should stay green: ${r.stderr.slice(0, 300)}`);
});
