// Invariants telemetry reporter — fail-first tests.
//
// Contract under test (docs/INVARIANTS-TELEMETRY.md):
// - startRun() writes a run_start line with run_id + repo_sha
// - record() writes invariant_result lines (name/status/duration_ms/message)
// - check(name, fn) times fn: resolve -> pass, throw -> fail with message
// - endRun() writes run_end with counts + status, returns the summary
// - readResults()/latestRun() parse JSONL and pick the latest run
// - CLI start/record/end round-trips through a results file
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { InvariantsReporter, readResults, latestRun } from "../scripts/invariants-reporter.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "scripts", "invariants-reporter.mjs");

function freshDir() {
  return mkdtempSync(join(tmpdir(), "inv-reporter-"));
}

function linesOf(path) {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

test("startRun writes a run_start line honoring the INVARIANTS_SHA override", () => {
  const dir = freshDir();
  try {
    const out = join(dir, "invariants.jsonl");
    const rep = new InvariantsReporter({ outPath: out, sha: "deadbeef".repeat(10).slice(0, 40), harness: "test-harness" });
    rep.startRun();
    const lines = linesOf(out);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].type, "run_start");
    assert.match(lines[0].run_id, /^inv_\d+_[0-9a-f]{6}$/);
    assert.equal(lines[0].repo_sha, "deadbeef".repeat(10).slice(0, 40));
    assert.equal(lines[0].harness, "test-harness");
    assert.ok(Date.parse(lines[0].started_at), "started_at is a parseable timestamp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record appends invariant_result lines with all contract fields", () => {
  const dir = freshDir();
  try {
    const out = join(dir, "invariants.jsonl");
    const rep = new InvariantsReporter({ outPath: out, sha: "abc" });
    const { runId } = rep.startRun();
    rep.record({ name: "mint-throttle", status: "pass", durationMs: 12 });
    rep.record({ name: "claim-release-cas", status: "fail", durationMs: 203, message: "throttle never engaged" });
    rep.record({ name: "unrun-thing", status: "skip", durationMs: 0 });
    const lines = linesOf(out);
    assert.equal(lines.length, 4);
    const r = lines[1];
    assert.equal(r.type, "invariant_result");
    assert.equal(r.run_id, runId);
    assert.equal(r.repo_sha, "abc");
    assert.equal(r.name, "mint-throttle");
    assert.equal(r.status, "pass");
    assert.equal(r.duration_ms, 12);
    assert.ok(Date.parse(r.started_at) && Date.parse(r.finished_at));
    assert.equal(lines[2].message, "throttle never engaged");
    assert.equal(lines[3].status, "skip");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record rejects unknown statuses and negative durations", () => {
  const dir = freshDir();
  try {
    const rep = new InvariantsReporter({ outPath: join(dir, "x.jsonl"), sha: "abc" });
    rep.startRun();
    assert.throws(() => rep.record({ name: "n", status: "maybe" }), /status/);
    assert.throws(() => rep.record({ name: "n", status: "pass", durationMs: -1 }), /duration/);
    assert.throws(() => rep.record({ status: "pass" }), /name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check() records pass on resolve and fail with the error message on throw", async () => {
  const dir = freshDir();
  try {
    const out = join(dir, "invariants.jsonl");
    const rep = new InvariantsReporter({ outPath: out, sha: "abc" });
    rep.startRun();
    await rep.check("ok-invariant", async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    await rep.check("bad-invariant", async () => {
      throw new Error("boom: invariant violated");
    });
    const lines = linesOf(out);
    assert.equal(lines[1].status, "pass");
    assert.ok(lines[1].duration_ms >= 0, "duration measured");
    assert.equal(lines[2].status, "fail");
    assert.match(lines[2].message, /boom: invariant violated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("endRun writes run_end with counts and returns the summary; any fail -> status fail", () => {
  const dir = freshDir();
  try {
    const out = join(dir, "invariants.jsonl");
    const rep = new InvariantsReporter({ outPath: out, sha: "abc" });
    rep.startRun();
    rep.record({ name: "a", status: "pass", durationMs: 1 });
    rep.record({ name: "b", status: "fail", durationMs: 2 });
    rep.record({ name: "c", status: "skip", durationMs: 0 });
    rep.record({ name: "d", status: "error", durationMs: 3 });
    const summary = rep.endRun();
    assert.deepEqual(summary.counts, { pass: 1, fail: 1, skip: 1, error: 1 });
    assert.equal(summary.status, "fail");
    const lines = linesOf(out);
    const end = lines.at(-1);
    assert.equal(end.type, "run_end");
    assert.deepEqual(end.counts, summary.counts);
    assert.equal(end.status, "fail");
    assert.ok(end.duration_ms >= 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("endRun reports pass status for an all-pass run", () => {
  const dir = freshDir();
  try {
    const out = join(dir, "invariants.jsonl");
    const rep = new InvariantsReporter({ outPath: out, sha: "abc" });
    rep.startRun();
    rep.record({ name: "a", status: "pass", durationMs: 1 });
    assert.equal(rep.endRun().status, "pass");
    assert.equal(linesOf(out).at(-1).status, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readResults/latestRun parse a file and pick the latest run", () => {
  const dir = freshDir();
  try {
    const out = join(dir, "invariants.jsonl");
    const r1 = new InvariantsReporter({ outPath: out, sha: "sha1" });
    r1.startRun();
    r1.record({ name: "a", status: "fail", durationMs: 1 });
    r1.endRun();
    const r2 = new InvariantsReporter({ outPath: out, sha: "sha2" });
    r2.startRun();
    const r2Id = r2.runId;
    r2.record({ name: "a", status: "pass", durationMs: 2 });
    r2.endRun();
    const records = readResults(out);
    assert.equal(records.length, 6);
    const latest = latestRun(records);
    assert.equal(latest.runId, r2Id);
    assert.equal(latest.repoSha, "sha2");
    assert.equal(latest.results.length, 1);
    assert.equal(latest.results[0].status, "pass");
    assert.equal(latest.end.status, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readResults throws on malformed JSON lines", () => {
  const dir = freshDir();
  try {
    const out = join(dir, "bad.jsonl");
    writeFileSync(out, '{"type":"run_start"}\nnot json\n');
    assert.throws(() => readResults(out), /line 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI start/record/end round-trips through a results file", () => {
  const dir = freshDir();
  try {
    const out = join(dir, "invariants.jsonl");
    const env = { ...process.env, INVARIANTS_RESULTS_FILE: out, INVARIANTS_SHA: "cli-sha-1" };
    execFileSync(process.execPath, [CLI, "start", "--harness", "cli-harness"], { env });
    execFileSync(process.execPath, [CLI, "record", "--name", "cli-inv", "--status", "pass", "--duration-ms", "7"], { env });
    execFileSync(process.execPath, [CLI, "record", "--name", "cli-inv2", "--status", "fail", "--message", "cli boom", "--duration-ms", "3"], { env });
    execFileSync(process.execPath, [CLI, "end"], { env });
    const lines = linesOf(out);
    assert.equal(lines[0].type, "run_start");
    assert.equal(lines[0].repo_sha, "cli-sha-1");
    assert.equal(lines[0].harness, "cli-harness");
    assert.equal(lines[1].name, "cli-inv");
    assert.equal(lines[2].message, "cli boom");
    assert.deepEqual(lines[3].counts, { pass: 1, fail: 1, skip: 0, error: 0 });
    assert.equal(lines[3].status, "fail");
    assert.ok(!existsSync(out + ".run.json"), "run state file cleaned up by end");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI record without start fails loudly", () => {
  const dir = freshDir();
  try {
    const env = { ...process.env, INVARIANTS_RESULTS_FILE: join(dir, "x.jsonl") };
    assert.throws(
      () => execFileSync(process.execPath, [CLI, "record", "--name", "n", "--status", "pass"], { env, stdio: "pipe" }),
      /no active run/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
