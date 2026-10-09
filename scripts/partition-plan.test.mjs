// Tests for scripts/partition-plan.mjs (run: node scripts/partition-plan.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLANNER = join(HERE, "partition-plan.mjs");

function run(args, stdinFile) {
  const full = [...args];
  if (stdinFile) full.push(stdinFile);
  try {
    const out = execFileSync(process.execPath, [PLANNER, ...full], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function writeTasks(tasks, claimPrefix = "t") {
  const dir = mkdtempSync(join(tmpdir(), "partition-plan-"));
  const file = join(dir, "tasks.json");
  writeFileSync(file, JSON.stringify({ claimPrefix, tasks }));
  return file;
}

const t = (id, files, dirs = []) => ({ id, files, dirs });

test("WAVE-300 demo: 40 tasks -> 10 conflict-free partitions, 4 tasks each", () => {
  const { code, out } = run(["--demo", "wave300", "--partitions", "10"]);
  assert.equal(code, 0, `expected exit 0, got ${code}:\n${out}`);
  assert.match(out, /PARTITION PLAN — 40 tasks → 10 partitions/);
  assert.match(out, /cross-partition overlap : NONE/);
  assert.match(out, /balance\s+: OK/);
  assert.match(out, /claim namespaces unique : yes/);
  for (let p = 0; p < 10; p++) {
    assert.match(out, new RegExp(`\\[wave300-p${p}\\] 4 tasks`), `partition p${p} missing or wrong size`);
  }
});

test("WAVE-300 demo: machine JSON has unique namespaces and waves", () => {
  const dir = mkdtempSync(join(tmpdir(), "partition-plan-json-"));
  const file = join(dir, "plan.json");
  const { code } = run(["--demo", "wave300", "--partitions", "10", "--out", file]);
  assert.equal(code, 0);
  const plan = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(plan.partitions.length, 10);
  const ns = plan.partitions.map((p) => p.claimNamespace);
  assert.equal(new Set(ns).size, 10, "claim namespaces must be unique");
  assert.deepEqual(plan.verification.sizes, Array(10).fill(4));
  assert.equal(plan.verification.crossPartitionOverlaps.length, 0);
  assert.equal(plan.verification.balanced, true);
  for (const p of plan.partitions) {
    assert.ok(Array.isArray(p.waves) && p.waves.length >= 1, "waves missing");
    assert.deepEqual(p.waves.flat().sort(), p.taskIds.slice().sort(), "waves must cover the partition's tasks");
  }
});

test("conflicting tasks (shared file) are colocated, never split", () => {
  const f = writeTasks([t("a1", ["server/shared.mjs"]), t("a2", ["server/shared.mjs"]), t("b1", ["server/b.mjs"])]);
  const { code, out } = run(["--tasks", f, "-k", "2"]);
  assert.equal(code, 0, `expected exit 0, got ${code}:\n${out}`);
  assert.match(out, /cross-partition overlap : NONE/);
  // a1 and a2 must sit in the same partition — find which [ns] lines contain them
  const a1Line = out.split("\n").find((l) => l.includes("[t-p") && l.includes("tasks"));
  const sections = out.split(/(?=\[t-p\d+\])/);
  const sec = sections.find((s) => s.includes("a1"));
  assert.ok(sec.includes("a2"), "a1 and a2 must be in the same partition");
  assert.match(out, /internal conflicts\s+: 1/, "the colocated conflict must be reported for in-lane serialization");
  assert.ok(a1Line);
});

test("dir overlap counts as conflict (segment-aware)", () => {
  const f = writeTasks([t("x", [], ["server/claims"]), t("y", ["server/claims/board.mjs"])]);
  const { code, out } = run(["--tasks", f, "-k", "1"]);
  assert.equal(code, 0, out);
  assert.match(out, /internal conflicts\s+: 1/);
  // but server/claims must NOT match server/claimsmore.mjs
  const f2 = writeTasks([t("x", [], ["server/claims"]), t("y", ["server/claimsmore.mjs"])]);
  const r2 = run(["--tasks", f2, "-k", "2"]);
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /cross-partition overlap : NONE/);
  assert.match(r2.out, /edges \/ colors \/ groups : 0 edges/);
});

test("K greater than independent-group count errors without --allow-overlap", () => {
  const f = writeTasks([
    t("a1", ["server/shared.mjs"]),
    t("a2", ["server/shared.mjs"]),
    t("b1", ["server/b.mjs"]),
    t("c1", ["server/c.mjs"]),
  ]);
  const { code, out } = run(["--tasks", f, "-k", "4"]);
  assert.equal(code, 2, `expected exit 2, got ${code}:\n${out}`);
  assert.match(out, /fewer than 4 requested partitions/);
});

test("--allow-overlap splits groups but reports violations with exit 1", () => {
  const f = writeTasks([
    t("a1", ["server/shared.mjs"]),
    t("a2", ["server/shared.mjs"]),
    t("b1", ["server/b.mjs"]),
    t("c1", ["server/c.mjs"]),
  ]);
  const { code, out } = run(["--tasks", f, "-k", "4", "--allow-overlap"]);
  assert.equal(code, 1, `expected exit 1, got ${code}:\n${out}`);
  assert.match(out, /1 VIOLATIONS/);
});

test("indivisible oversized component reports honest imbalance with exit 1", () => {
  const tasks = ["a", "b", "c", "d", "e"].map((id) => t("big-" + id, ["s/m.mjs"]));
  tasks.push(t("solo1", []), t("solo2", []));
  const f = writeTasks(tasks, "d");
  const { code, out } = run(["--tasks", f, "-k", "2"]);
  assert.equal(code, 1, `expected exit 1, got ${code}:\n${out}`);
  assert.match(out, /balance\s+: IMBALANCED/);
  assert.match(out, /cross-partition overlap : NONE/); // property (a) still holds
});

test("duplicate task ids and K > task count are usage errors (exit 2)", () => {
  const f = writeTasks([t("x", []), t("x", [])]);
  assert.equal(run(["--tasks", f, "-k", "2"]).code, 2);
  const f2 = writeTasks([t("x", [])]);
  assert.equal(run(["--tasks", f2, "-k", "3"]).code, 2);
  assert.equal(run(["--tasks", f2, "-k", "0"]).code, 2);
});

test("planner is deterministic: identical input, byte-identical output", () => {
  const r1 = run(["--demo", "wave300", "--partitions", "10"]);
  const r2 = run(["--demo", "wave300", "--partitions", "10"]);
  assert.equal(r1.code, 0);
  assert.equal(r2.out, r1.out, "demo output must be byte-identical across runs");
});
