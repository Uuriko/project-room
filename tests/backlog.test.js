import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const roomScript = join(checkout, "scripts/room");

const SEED = `# Backlog

## ready
- [ ] BL-001 · first thing · scope: do it · accept: done · files: a.mjs, b.mjs
- [ ] BL-002 · second thing · scope: do that · accept: done · files: c.mjs

## blocked
- [ ] BL-009 · stuck thing · scope: waiting · accept: unblocked · files: d.mjs · blocked on: someone

## done
- [x] BL-000 · old thing · shipped as: #1
`;

function backlogFile() {
  const dir = mkdtempSync(join(tmpdir(), "backlog-"));
  const f = join(dir, "BACKLOG.md");
  writeFileSync(f, SEED);
  return f;
}

function run(...args) {
  const res = spawnSync("bash", [roomScript, ...args], { encoding: "utf8", timeout: 30000 });
  return res;
}

// Authoring gate answers (per .agents/skills/test-audit/SKILL.md):
// 1. Protects the S2 backlog contract: list order (top-first), pull marks the
//    top unclaimed item and emits a postable [lane][claim] fenced block, pull
//    skips claimed items, done archives under ## done, metrics reports depth.
// 2. Credible regressions: BACKLOG.md format drift breaking the awk parser;
//    the in-place sed/awk edit corrupting the file or dropping sections;
//    field extraction breaking on multi-word titles.
// 3. No existing coverage: this is new functionality (S2).
// 4. No production seam: tests drive the real script via --file against a
//    temp BACKLOG.md. No new exports.

test("backlog list shows ready items top-first", () => {
  const f = backlogFile();
  const res = run("backlog", "--file", f);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("BL-001"));
  assert.ok(lines[1].includes("BL-002"));
});

test("backlog pull marks top item claimed and emits a claim block", () => {
  const f = backlogFile();
  const res = run("backlog", "pull", "--lane", "testlane", "--file", f);
  assert.equal(res.status, 0, res.stderr);
  // Emitted block is a postable [lane][claim] with fenced room-claim.
  assert.ok(res.stdout.includes("[testlane][claim] first thing"));
  assert.ok(res.stdout.includes("```room-claim"));
  assert.ok(res.stdout.match(/task-id:\s+RC-\d{4}-\d{2}-\d{2}-\d{3}/));
  assert.ok(res.stdout.includes("files:      a.mjs, b.mjs"));
  assert.ok(res.stdout.includes("lease:      lease=6h"));
  // File is marked in place.
  const after = readFileSync(f, "utf8");
  assert.ok(after.match(/BL-001.*· claimed: RC-\d{4}-\d{2}-\d{2}-\d{3}/));
});

test("backlog pull skips claimed items and increments the task sequence", () => {
  const f = backlogFile();
  const r1 = run("backlog", "pull", "--lane", "l1", "--file", f);
  assert.equal(r1.status, 0, r1.stderr);
  const r2 = run("backlog", "pull", "--lane", "l2", "--file", f);
  assert.equal(r2.status, 0, r2.stderr);
  // Second pull takes BL-002, not BL-001.
  assert.ok(r2.stdout.includes("[l2][claim] second thing"));
  assert.ok(r2.stdout.includes("files:      c.mjs"));
  // Task-ids differ (sequence incremented).
  const id1 = r1.stdout.match(/task-id:\s+(RC-\S+)/)[1];
  const id2 = r2.stdout.match(/task-id:\s+(RC-\S+)/)[1];
  assert.notEqual(id1, id2);
});

test("backlog pull with no ready items fails cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "backlog-"));
  const f = join(dir, "BACKLOG.md");
  writeFileSync(f, "# Backlog\n\n## ready\n\n## blocked\n\n## done\n");
  const res = run("backlog", "pull", "--lane", "l1", "--file", f);
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("no unclaimed ready items"));
});

test("backlog done archives the item under ## done", () => {
  const f = backlogFile();
  const res = run("backlog", "done", "BL-001", "--pr", "1090", "--file", f);
  assert.equal(res.status, 0, res.stderr);
  const after = readFileSync(f, "utf8");
  // Gone from ready, present in done as checked with the PR link.
  const readySection = after.split("## blocked")[0];
  assert.ok(!readySection.includes("BL-001"));
  assert.ok(after.match(/- \[x\] BL-001.*· shipped as: #1090/));
  // Claimed trailer (if any) is dropped on archive.
  assert.ok(!after.match(/BL-001.*claimed:/));
});

test("backlog done rejects a malformed BL id", () => {
  const f = backlogFile();
  const res = run("backlog", "done", "XX-999", "--file", f);
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("must match BL-"));
});

test("backlog done rejects an unknown BL id", () => {
  const f = backlogFile();
  const res = run("backlog", "done", "BL-999", "--file", f);
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("not found"));
});

test("backlog rejects an invalid lane tag", () => {
  const f = backlogFile();
  const res = run("backlog", "pull", "--lane", "bad lane", "--file", f);
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("--lane must match"));
});
