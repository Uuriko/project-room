import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = new URL("../scripts/pre-pr-board-scan.mjs", import.meta.url).pathname;

function boardFixture(claims) {
  const dir = mkdtempSync(join(tmpdir(), "board-scan-"));
  const path = join(dir, "board.json");
  writeFileSync(path, JSON.stringify({ claims }));
  return path;
}

function run(args, { cwd } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: process.env.TMPDIR || join(cwd || tmpdir(), ".tmp") },
  });
}

// Fail-first: this test requires scripts/pre-pr-board-scan.mjs to exist and
// implement the overlap scan. Watch it fail before the implementation lands.

test("overlap → non-zero exit and names the colliding claim", (t) => {
  const fixture = boardFixture([
    { id: "other-1", title: "Rebuild claim boards", state: "in_progress", files: ["server/claims.mjs", "docs/ROOM-COORDINATION.md"] },
    { id: "unrelated", title: "Totally separate work", state: "claimed", files: ["client/theme.css"] },
  ]);
  const r = run(["--board", fixture, "--files", "server/claims.mjs,server/other.mjs"]);
  assert.notEqual(r.status, 0, `expected non-zero exit, got status=${r.status} out=${r.stdout} err=${r.stderr}`);
  assert.match(r.stdout + r.stderr, /other-1/, "colliding claim id is named");
  assert.match(r.stdout + r.stderr, /convergent work/i, "overlap report language is present");
});

test("disjoint → exit 0", (t) => {
  const fixture = boardFixture([
    { id: "other-1", title: "Rebuild claim boards", state: "in_progress", files: ["server/claims.mjs"] },
  ]);
  const r = run(["--board", fixture, "--files", "server/other.mjs"]);
  assert.equal(r.status, 0, `expected exit 0, got status=${r.status} out=${r.stdout} err=${r.stderr}`);
});

test("own claim is excluded from results", (t) => {
  const fixture = boardFixture([
    { id: "mine", title: "My own fix", state: "in_progress", files: ["server/claims.mjs"] },
    { id: "other-1", title: "Their fix", state: "in_progress", files: ["server/claims.mjs"] },
  ]);
  const r = run(["--board", fixture, "--claim", "mine", "--files", "server/claims.mjs"]);
  assert.equal(r.status, 1, `expected exit 1 for OTHER claim overlap, got status=${r.status} out=${r.stdout} err=${r.stderr}`);
  assert.match(r.stdout + r.stderr, /other-1/);
  const r2 = run(["--board", fixture, "--claim", "mine", "--files", "server/claims.mjs", "--quiet"]);
  assert.ok(!/mine/.test(r2.stdout), "own claim id must not appear in the collision list");
});

test("own claim with no other overlap → exit 0", (t) => {
  const fixture = boardFixture([
    { id: "mine", title: "My own fix", state: "in_progress", files: ["server/claims.mjs"] },
  ]);
  const r = run(["--board", fixture, "--claim", "mine", "--files", "server/claims.mjs"]);
  assert.equal(r.status, 0, `expected exit 0, got status=${r.status} out=${r.stdout} err=${r.stderr}`);
});

test("inactive claims do not collide (completed/cancelled)", (t) => {
  const fixture = boardFixture([
    { id: "done-1", title: "Shipped long ago", state: "completed", files: ["server/claims.mjs"] },
    { id: "dead-1", title: "Abandoned", state: "cancelled", files: ["server/claims.mjs"] },
  ]);
  const r = run(["--board", fixture, "--files", "server/claims.mjs"]);
  assert.equal(r.status, 0, `expected exit 0, got status=${r.status} out=${r.stdout} err=${r.stderr}`);
});

test("claim without files is unscannable: warned, not counted as collision", (t) => {
  const fixture = boardFixture([
    { id: "no-files", title: "Vague claim", state: "claimed" },
  ]);
  const r = run(["--board", fixture, "--files", "server/claims.mjs"]);
  assert.equal(r.status, 0, `expected exit 0, got status=${r.status} out=${r.stdout} err=${r.stderr}`);
  assert.match(r.stderr, /unscannable|no files/i, "unscannable claim is warned about");
});

test("missing fixture file → exit 3 with a clear error", (t) => {
  const r = run(["--board", "/nonexistent/board.json", "--files", "server/claims.mjs"]);
  assert.equal(r.status, 3, `expected exit 3, got status=${r.status} out=${r.stdout} err=${r.stderr}`);
});

test("no files given at all → usage error exit 2", (t) => {
  const r = run(["--board", "/dev/null"]);
  assert.equal(r.status, 2, `expected exit 2, got status=${r.status} out=${r.stdout} err=${r.stderr}`);
});

test("--json emits a machine-readable report", (t) => {
  const fixture = boardFixture([
    { id: "other-1", title: "Rebuild claim boards", state: "in_progress", files: ["server/claims.mjs"] },
  ]);
  const r = run(["--board", fixture, "--files", "server/claims.mjs", "--json"]);
  assert.equal(r.status, 1);
  const report = JSON.parse(r.stdout);
  assert.equal(report.collisions.length, 1);
  assert.equal(report.collisions[0].id, "other-1");
  assert.deepEqual(report.collisions[0].overlappingFiles, ["server/claims.mjs"]);
});
