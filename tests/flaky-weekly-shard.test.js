// TST-01A: the weekly flaky lane's shard runner and workflow.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { parseArgs, parseShardArg, recordName, runShard, shardFiles } from "../scripts/flaky-weekly-shard.mjs";
import { discoverUnitTests } from "../scripts/unit-shards.mjs";

test("shards are a partition of the test files", () => {
  const files = discoverUnitTests("tests");
  assert.ok(files.length > 100);
  const seen = [];
  for (let i = 1; i <= 8; i++) seen.push(...shardFiles(files, { index: i, total: 8 }));
  assert.equal(seen.length, files.length);
  assert.deepEqual([...seen].sort(), [...files].sort());
  const sizes = Array.from({ length: 8 }, (_, i) => shardFiles(files, { index: i + 1, total: 8 }).length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `round robin keeps shard sizes even: ${sizes}`);
});

test("argument parsing refuses bad shards and run counts", () => {
  assert.deepEqual(parseShardArg("3/8"), { index: 3, total: 8 });
  for (const bad of ["0/8", "9/8", "8", "a/b", "", undefined]) assert.throws(() => parseShardArg(bad));
  assert.throws(() => parseArgs([]), /--shard is required/);
  assert.throws(() => parseArgs(["--shard=1/8", "--runs=1"]), /runs/);
  assert.throws(() => parseArgs(["--shard=1/8", "--bogus=1"]), /unknown argument/);
  const o = parseArgs(["--shard=2/4", "--runs=3", "--out=x", "--budget-minutes=10"]);
  assert.equal(o.runs, 3); assert.equal(o.out, "x"); assert.equal(o.budgetMinutes, 10);
  assert.equal(recordName("tests/a/b.test.js"), "tests__a__b.test.js.json");
});

test("runShard writes one record per file, a summary, and lists budget-skipped files", async (t) => {
  const out = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "flaky-shard-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const files = ["tests/a.test.js", "tests/b.test.js", "tests/c.test.js", "tests/d.test.js"];
  let clock = 0;
  const detect = async (file, { runs }) => {
    clock += 60_000;
    if (file.endsWith("b.test.js")) return { file, runs, flaky: [{ name: "x", passes: 2, fails: 1 }], runErrors: [], exitCode: 1, error: null };
    if (file.endsWith("c.test.js")) return { file, runs, flaky: [], runErrors: ["no tests detected"], exitCode: 2, error: null };
    return { file, runs, flaky: [], runErrors: [], exitCode: 0, error: null };
  };
  const s = await runShard({ shard: { index: 1, total: 1 }, runs: 3, timeout: 5000, budgetMinutes: 3, out, dir: "tests" },
    { detect, now: () => clock, discover: () => files });
  assert.equal(s.files, 4);
  assert.equal(s.checked, 3);
  assert.deepEqual(s.skipped, ["tests/d.test.js"]);
  assert.deepEqual(s.flakyFiles, [{ file: "tests/b.test.js", tests: ["x"] }]);
  assert.equal(s.errorFiles[0].file, "tests/c.test.js");
  const written = readdirSync(out).sort();
  assert.deepEqual(written, ["shard-summary.json", "tests__a.test.js.json", "tests__b.test.js.json", "tests__c.test.js.json"]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, "shard-summary.json"), "utf8")).skipped, ["tests/d.test.js"]);
});

test("flaky-weekly workflow is detection only, sharded, bounded and secret-free", () => {
  const text = readFileSync(new URL("../.github/workflows/flaky-weekly.yml", import.meta.url), "utf8");
  const wf = parse(text);
  assert.ok("workflow_dispatch" in wf.on);
  assert.ok(Array.isArray(wf.on.schedule) && wf.on.schedule[0].cron);
  assert.equal(wf.on.pull_request, undefined, "never runs on PRs");
  assert.equal(wf.on.push, undefined, "never runs on pushes");
  assert.deepEqual(wf.permissions, { contents: "read" });
  const job = wf.jobs.detect;
  assert.equal(job["continue-on-error"], true);
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] < 360);
  assert.equal(job.strategy["fail-fast"], false);
  assert.deepEqual(job.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7, 8]);
  const run = job.steps.map((s) => s.run ?? "").join("\n");
  assert.match(run, /flaky-weekly-shard\.mjs --shard="\$SHARD\/8"/);
  const budget = Number(/--budget-minutes=(\d+)/.exec(run)[1]);
  assert.ok(budget < job["timeout-minutes"] - 20, "the budget leaves room for setup and upload");
  const upload = job.steps.find((s) => String(s.uses).startsWith("actions/upload-artifact@"));
  assert.equal(upload.if, "always()");
  assert.doesNotMatch(text, /secrets\./, "uses no secrets");
});
