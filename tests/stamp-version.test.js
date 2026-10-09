// CLI arg-parsing tests for scripts/stamp-version.mjs (guild-06 fuzz).
// Unknown options and excess positionals must fail with a usage message on
// stderr and exit code 2 — never an uncaught stack trace, and never a stamp.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/stamp-version.mjs", import.meta.url));

test("unknown options and excess positionals exit 2 with usage, no stack trace", () => {
  for (const args of [["--bogus-flag-xyz"], ["--help"], ["a.mjs", "b.mjs"]]) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 15000 });
    assert.equal(r.status, 2, `expected exit 2 for [${args.join(" ")}], got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Usage:/, "usage goes to stderr");
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace on usage error");
    assert.equal(r.stdout, "", "nothing stamped on stdout");
  }
});
