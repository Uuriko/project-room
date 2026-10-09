// Worker-23 fail-first regression tests (guild-06): usage errors across shard
// scripts must print a usage line to stderr and exit 2 — never an uncaught
// stack trace — and must not create rogue directories for flag-like args.
// Covers F1 (helper-owner-exercise.mjs) and F2 (stall-probe.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = p => `${root}/scripts/${p}`;
const run = (name, args) => spawnSync(process.execPath, [script(name), ...args], {
  encoding: "utf8", timeout: 20000, cwd: root,
});

test("helper-owner-exercise.mjs (no args): usage to stderr, exit 2, no stack trace", () => {
  const r = run("helper-owner-exercise.mjs", []);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
  assert.match(r.stderr, /Usage:/i, "usage goes to stderr");
  assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
});

test("helper-owner-exercise.mjs (flag-like evidence dir): rejected, no rogue dir", () => {
  const rogue = `${root}/--worker23-rogue-dir`;
  assert.equal(existsSync(rogue), false, "precondition: rogue dir absent");
  const r = run("helper-owner-exercise.mjs", ["fixture.json", "select", "offer123", "--worker23-rogue-dir"]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
  assert.match(r.stderr, /Usage:/i, "usage goes to stderr");
  assert.equal(existsSync(rogue), false, "no rogue directory created for a flag-like output arg");
});

test("stall-probe.mjs (unknown option): usage to stderr, exit 2, never probes", () => {
  const r = run("stall-probe.mjs", ["--bogus-flag", "--url", "https://example.invalid", "--seconds", "1"]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
  assert.match(r.stderr, /Usage:/i, "usage goes to stderr");
  assert.doesNotMatch(r.stderr, /fetch failed/i, "must not reach the network on an unknown option");
});

test("stall-probe.mjs (--help): usage to stderr, exit 2", () => {
  const r = run("stall-probe.mjs", ["--help"]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
  assert.match(r.stderr, /Usage:/i, "usage goes to stderr");
});
