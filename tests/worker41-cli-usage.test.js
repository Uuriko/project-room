// WORKER-41 (guild-06): CLI usage hardening for shard-41 scripts.
// Unknown flags / --help must print a usage line to stderr and exit 2 —
// never silently trigger a live run (review-state --bogus used to fire a
// live `gh api` call; procedures-index --bogus rewrote the generated index),
// and malformed JSON inputs must fail clean, not with a stack trace.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = (p) => join(root, "scripts", p);

const CASES = [
  // [script, args, note]
  ["review-state.mjs", ["--bogus"], "unknown flag must not trigger a live gh run"],
  ["review-state.mjs", ["--help"], "--help prints usage"],
  ["review-state.mjs", ["--inputt", "x.json"], "typo'd flag value pair is still unknown"],
  ["procedures-index.mjs", ["--bogus"], "unknown flag must not rewrite the index"],
  ["procedures-index.mjs", ["--help"], "--help prints usage"],
  ["docs-link-check.mjs", ["--bogus"], "zero-flag check rejects stray args"],
  ["docs-link-check.mjs", ["--help"], "--help prints usage"],
];

for (const [name, args, note] of CASES) {
  test(`${name} [${args.join(" ")}]: ${note}`, () => {
    const r = spawnSync(process.execPath, [script(name), ...args], {
      encoding: "utf8", timeout: 30000, cwd: root,
    });
    assert.equal(r.status, 2, `${name}: expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /Usage:/i, `${name}: usage goes to stderr`);
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, `${name}: no stack trace`);
  });
}

test("review-state --input with malformed JSON fails clean (exit 2, no stack)", () => {
  const dir = mkdtempSync(join(tmpdir(), "worker41-cli-"));
  try {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "not json{{{");
    const r = spawnSync(process.execPath, [script("review-state.mjs"), "--input", bad, "--format", "json"], {
      encoding: "utf8", timeout: 30000, cwd: root,
    });
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /cannot parse --input/, "names the bad flag and file");
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review-state --input with a valid fixture still works", () => {
  const dir = mkdtempSync(join(tmpdir(), "worker41-cli-"));
  try {
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({
      prs: [{ number: 7, title: "t", author: "alice", headSha: "abc", draft: false }],
      reviews: [],
    }));
    const r = spawnSync(process.execPath,
      [script("review-state.mjs"), "--input", good, "--lanes", "fo,instinct", "--format", "json"], {
        encoding: "utf8", timeout: 30000, cwd: root,
      });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.states[0].verdict.status, "awaiting_review");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
