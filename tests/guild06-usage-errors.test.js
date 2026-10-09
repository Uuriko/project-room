// Guild-06 fuzz regression: usage errors across scripts/* must print a usage
// line to stderr and exit 2 — never an uncaught stack trace. Covers every
// script converted from `throw new Error("Usage: ...")` in the guild-06 pass.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = (p) => `${root}/scripts/${p}`;

const CASES = [
  // [script, args that must fail clean]
  ["acceptance-handoff.mjs", []],
  ["acceptance-handoff.mjs", ["--help"]],
  ["assisted-agent-exercise.mjs", ["--help"]],
  ["audit-native-request-evidence.mjs", ["--help"]],
  ["browser-ci.mjs", ["--bogus"]],
  ["deploy-recovery.mjs", ["--help"]],
  ["discovery-profile.mjs", ["--help"]],
  ["inbox-sandbox.mjs", []],
  ["inbox-sandbox.mjs", ["--help"]],
  ["native-host-request-run.mjs", ["--help"]],
  ["real-agent-fixture.mjs", []],
  ["report-unit-failures.mjs", []],
  ["unit-ci.mjs", ["--bogus"]],
  ["worker-ci-build.mjs", ["--bogus"]],
  ["request-host-fixture.mjs", ["--help"]],
];

for (const [name, args] of CASES) {
  test(`${name} [${args.join(" ") || "(no args)"}]: usage error exits 2 without a stack trace`, () => {
    const r = spawnSync(process.execPath, [script(name), ...args], {
      encoding: "utf8", timeout: 20000, cwd: root,
    });
    assert.equal(r.status, 2, `${name}: expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /Usage:/i, `${name}: usage goes to stderr`);
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, `${name}: no stack trace`);
  });
}
