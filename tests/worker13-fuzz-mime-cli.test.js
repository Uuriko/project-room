// Guild-06 worker-13: fuzz-mime CLI hardening.
//
// Two CLI bugs (repro: node scripts/fuzz-mime.mjs --seedd 5 --skip-corpus):
//  1. Unknown long options with values were silently accepted -- a typo like
//     --iteration 50 (vs --iterations) ran the full 20000-case default sweep
//     and exited 0, a false-green config for a scheduled fuzz gate.
//  2. --corpus <unreadable dir> died with an uncaught ENOENT stack trace and
//     exit 1 instead of a clean usage error.
// Both must now print a Usage line to stderr and exit 2, with no stack trace.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "fuzz-mime.mjs");

const run = (args, timeout = 30000) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout,
    cwd: root,
    env: { ...process.env, TMPDIR: join(root, ".tmp"), NO_COLOR: "1" },
  });

const cleanUsageError = (name, args, extra = []) => {
  test(`${name}: usage error exits 2 with a Usage line and no stack trace`, () => {
    const r = run(args);
    assert.equal(r.status, 2, `${name}: expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /Usage:/i, `${name}: usage goes to stderr`);
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, `${name}: no stack trace`);
    for (const re of extra) assert.match(r.stderr, re, `${name}: stderr names the bad input`);
  });
};

// Bug 1: unknown valued options must not be silently swallowed.
cleanUsageError("misspelled --seedd 5", ["--seedd", "5", "--skip-corpus", "--quiet"], [/--seedd/]);
cleanUsageError("unknown --bogus=x", ["--bogus=x"], [/--bogus/]);
// Guild-06 convention (13 converted scripts): --help is a usage error.
cleanUsageError("--help", ["--help"]);

// Bug 2: an unreadable --corpus must fail clean, naming --corpus.
cleanUsageError("unreadable --corpus", ["--corpus", "/nonexistent-guild13-fuzz-mime-xyz"], [/--corpus/]);

test("valid flags still run the fuzz and exit 0", { timeout: 120000 }, () => {
  const report = mkdtempSync(join(tmpdir(), "w13-fuzz-ok-"));
  const r = run(["--skip-corpus", "--quiet", "--seed", "7", "--iterations", "3",
    "--budget-ms", "60000", "--max-ms", "5000", "--report", report]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr.slice(0, 300)}`);
});
