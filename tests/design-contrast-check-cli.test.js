// Worker-39 (guild-06) fail-first: design-contrast-check.mjs takes no options.
// An unknown flag (e.g. a typo'd gate knob) must fail loudly — usage to
// stderr + exit 2 — not silently run the gate as if the flag did not exist.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (args) =>
  spawnSync(process.execPath, [`${root}/scripts/design-contrast-check.mjs`, ...args], {
    encoding: "utf8", timeout: 20000, cwd: root,
  });

for (const args of [["--bogus"], ["--help"], ["pair=button"]]) {
  test(`[${args.join(" ")}] exits 2 with usage, never a silent pass`, () => {
    const r = run(args);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stdout.slice(0, 200)}`);
    assert.match(r.stderr, /Usage:/i, "usage goes to stderr");
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
    assert.doesNotMatch(r.stdout, /pairs meet/, "gate must not report a pass on misuse");
  });
}

test("no args still runs the gate", () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stderr.slice(0, 300));
  assert.match(r.stdout, /pairs meet WCAG/);
});
