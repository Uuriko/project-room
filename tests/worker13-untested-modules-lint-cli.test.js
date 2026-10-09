// Guild-06 worker-13: untested-modules-lint takes no options, so any CLI arg
// is a usage error. Repro: node scripts/untested-modules-lint.mjs --bogus
// silently ran the whole lint and exited 0.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "untested-modules-lint.mjs");

const run = args =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 60000,
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
  });

for (const args of [["--bogus"], ["--help"], ["somefile.mjs"]]) {
  test(`untested-modules-lint [${args.join(" ")}]: usage error exits 2, no stack trace`, () => {
    const r = run(args);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /Usage:/i, "usage goes to stderr");
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
  });
}

test("untested-modules-lint with no args still runs the gate", { timeout: 60000 }, () => {
  const r = run([]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr.slice(0, 300)}`);
  assert.match(r.stdout, /ok - .* server modules/);
});
