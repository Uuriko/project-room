// Guild-06 worker-37 shard hardening: CLI arg robustness for
// scripts/audit-invitations.mjs and scripts/pr-diff-size-check.mjs.
//
// Arg/usage errors must print a usage line to stderr and exit 2 — never an
// uncaught stack trace (exit 1). Unreadable --body-file paths and missing
// flag values are usage errors, not crashes.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = (p) => `${root}/scripts/${p}`;

function run(name, args, { env = {}, timeout = 30000 } = {}) {
  return spawnSync(process.execPath, [script(name), ...args], {
    encoding: "utf8",
    timeout,
    cwd: root,
    env: { ...process.env, TMPDIR: `${root}/.tmp`, ...env },
  });
}

function cleanUsageExit(t, name, args) {
  const r = run(name, args);
  assert.equal(r.status, 2, `${name} [${args.join(" ")}]: expected exit 2, got ${r.status}: ${r.stderr.slice(0, 400)}`);
  assert.match(r.stderr, /[Uu]sage:/, `${name}: usage goes to stderr`);
  assert.doesNotMatch(r.stderr, /^\s*at\s/m, `${name}: no stack trace`);
  return r;
}

for (const args of [
  ["--definitely-not-a-real-flag-xyz"],
  ["/tmp"],
  ["--db"],
]) {
  test(`audit-invitations [${args.join(" ")}]: arg error exits 2 without a stack trace`, (t) => {
    cleanUsageExit(t, "audit-invitations.mjs", args);
  });
}

test("audit-invitations --db <missing>: still exits 1 with the operator message, no stack", () => {
  const r = run("audit-invitations.mjs", ["--db", "/nonexistent-guild06-xyz/room.sqlite"]);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr.slice(0, 400)}`);
  assert.match(r.stderr, /could not establish consistency/i);
  assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
});

const BASE_HEAD = ["--base", "deadbeef", "--head", "feedface"];

for (const args of [
  [...BASE_HEAD, "--body-file", "/nonexistent-guild06-xyz/body.txt"],
  [...BASE_HEAD, "--body-file", "/tmp"], // directory, not a file
  [...BASE_HEAD, "--body-b64"], // missing flag value
  ["--bogus-flag"],
]) {
  test(`pr-diff-size-check [${args.join(" ")}]: arg error exits 2 without a stack trace`, (t) => {
    cleanUsageExit(t, "pr-diff-size-check.mjs", args);
  });
}

test("pr-diff-size-check --help: prints usage and exits 0", () => {
  const r = run("pr-diff-size-check.mjs", ["--help"]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr.slice(0, 400)}`);
  assert.match(r.stdout, /--base/, "usage on stdout");
});

test("pr-diff-size-check keeps working with env-provided SHAs (workflow path)", () => {
  // The GitHub workflow calls the script with no args and env SHAs; it must
  // still attempt the diff rather than die on arg parsing.
  const r = run("pr-diff-size-check.mjs", [], {
    env: { BASE_SHA: "HEAD~1", HEAD_SHA: "HEAD", PR_BODY: "no justification" },
  });
  assert.ok([0, 1, 2].includes(r.status), `unexpected status ${r.status}: ${r.stderr.slice(0, 300)}`);
  assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
});
