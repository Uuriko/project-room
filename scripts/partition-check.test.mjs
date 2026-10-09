// Tests for scripts/partition-check.mjs (run: node scripts/partition-check.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { allWaves, overlapPair } from "./partition-check.fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "partition-check.mjs");

function run(fixture) {
  const dir = mkdtempSync(join(tmpdir(), "partition-check-"));
  const file = join(dir, "partitions.json");
  writeFileSync(file, JSON.stringify(fixture));
  try {
    const out = execFileSync(process.execPath, [CHECKER, file], {
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

test("real wave data (21 partitions) PASSES with zero overlaps", () => {
  const { code, out } = run(allWaves);
  assert.equal(code, 0, `expected exit 0, got ${code}:\n${out}`);
  assert.match(out, /^PASS/);
  assert.equal(allWaves.partitions.length, 21);
});

test("deliberate overlap pair FAILS on all four axes", () => {
  const { code, out } = run(overlapPair);
  assert.equal(code, 1, `expected exit 1, got ${code}:\n${out}`);
  assert.match(out, /^FAIL/);
  // (a) dir-prefix containment: server/ vs server/claims/
  assert.match(out, /\[file\/dir\].*"server" ↔ "server\/claims"/);
  // (a) file inside the other's dir: server/http.mjs sits under... and
  // server/claims/board.mjs sits under server/
  assert.match(out, /\[file\/dir\].*server\/claims\/board\.mjs/);
  // (b) branch overlap
  assert.match(out, /\[branch\].*wave500\/coord-cost/);
  // (c) claim-id namespace overlap
  assert.match(out, /\[claim-id\].*wave500-coord-cost/);
  // (d) worktree overlap
  assert.match(out, /\[worktree\].*pr-wave500-coord-cost/);
});

test("usage error when fewer than two partitions", () => {
  const { code } = run({ partitions: [{ name: "solo" }] });
  assert.equal(code, 2);
});

test("identical claim ids and nested worktrees are overlaps", () => {
  const { code, out } = run({
    partitions: [
      {
        name: "x",
        worktree: "/tmp/wt",
        claimIds: ["abc-01"],
        files: ["server/http.mjs"],
      },
      {
        name: "y",
        worktree: "/tmp/wt/nested",
        claimIds: ["abc-01"],
        files: ["server/http.mjs"],
      },
    ],
  });
  assert.equal(code, 1, out);
  assert.match(out, /\[worktree\]/);
  assert.match(out, /\[claim-id\].*identical claim id/);
  assert.match(out, /\[file\/dir\]/);
});
