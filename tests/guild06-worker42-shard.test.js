// Guild-06 worker-42 shard regression: CLI arg hardening.
// None of the six shard scripts accepts flags (they are fixture drills and
// node:test browser journeys run by CI with no args). An unexpected argument
// must print a usage line to stderr and exit 2 — never silently run the full
// drill/suite, and never an uncaught stack trace.
// Fail-first: before the fix, --bogus ran the whole drill (exit 0) or started
// launching chromium (hang until the spawn timeout).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = (p) => `${root}/scripts/${p}`;

const CASES = [
  // [script, args that must fail clean]
  ["backup-drill.mjs", ["--bogus"]],
  ["backup-drill.mjs", ["--help"]],
  ["restore-rehearsal.mjs", ["--bogus"]],
  ["restore-rehearsal.mjs", ["--help"]],
  ["disclosure-check.mjs", ["--bogus"]],
  ["invitation-check.mjs", ["--bogus"]],
  ["pinned-messages-browser-check.mjs", ["--bogus"]],
  ["updates-browser-check.mjs", ["--bogus"]],
];

for (const [name, args] of CASES) {
  test(`${name} [${args.join(" ")}]: unexpected args print usage and exit 2`, () => {
    const r = spawnSync(process.execPath, [script(name), ...args], {
      encoding: "utf8", timeout: 30000, cwd: root,
    });
    assert.equal(r.status, 2, `${name}: expected exit 2, got ${r.status}: ${(r.stderr || "").slice(0, 300)}${r.error ? ` (${r.error.code})` : ""}`);
    assert.match(r.stderr, /Usage:/i, `${name}: usage goes to stderr`);
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, `${name}: no stack trace`);
  });
}
