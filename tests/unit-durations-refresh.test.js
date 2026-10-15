import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  refreshTable,
  serializeTable,
  loadReceipts,
  PROVENANCE_KEY,
} from "../scripts/refresh-unit-ci-durations.mjs";
import { parseJunitFileDurations } from "../scripts/unit-ci.mjs";
import { unmeasuredDefaultMs } from "../scripts/unit-shards.mjs";

// Fixture style mirrors tests/unit-shards.test.js: tmp dirs, no network.

function makeTree(t, { milliseconds = {}, extra = {}, files = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "unit-durations-refresh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "receipts"), { recursive: true });
  for (const file of files) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "// fixture\n");
  }
  const table = { milliseconds, ...extra };
  const outPath = join(dir, "scripts/unit-ci-durations.json");
  writeFileSync(outPath, serializeTable(table));
  return { dir, outPath, receiptsDir: join(dir, "receipts"), table };
}

function writeReceipt(dir, name, receipt) {
  writeFileSync(join(dir, name), typeof receipt === "string" ? receipt : JSON.stringify(receipt));
}

function runRefresh(t, fixture) {
  return spawnSync(
    process.execPath,
    ["scripts/refresh-unit-ci-durations.mjs", fixture.receiptsDir, fixture.outPath],
    { cwd: fixture.dir, encoding: "utf8", timeout: 30000 }
  );
}

// The refresh script resolves file existence against the tree holding the
// output table, so CLI tests need a copy of the script inside the fixture.
function copyScript(fixture) {
  writeFileSync(
    join(fixture.dir, "scripts/refresh-unit-ci-durations.mjs"),
    readFileSync("scripts/refresh-unit-ci-durations.mjs", "utf8")
  );
}

test("refresh: measured values win, max across receipts, absent preserved, deleted dropped, provenance recorded", (t) => {
  const files = ["tests/a.test.js", "tests/b.test.js", "tests/c.test.js"];
  const fixture = makeTree(t, {
    files,
    milliseconds: { "tests/a.test.js": 1000, "tests/b.test.js": 2000, "tests/gone.test.js": 3000 },
    extra: { _note: "keep me" },
  });
  const receipts = [
    {
      index: 1, runId: "run-1", revision: "rev-1",
      fileDurationsMs: { "tests/a.test.js": 1500, "tests/c.test.js": 4000, "tests/gone.test.js": 9000 },
    },
    {
      index: 2, runId: "run-1", revision: "rev-1",
      fileDurationsMs: { "tests/a.test.js": 2500 },
    },
  ];
  const fileExists = (file) => files.includes(file);
  const { table, changed } = refreshTable(fixture.table, receipts, { fileExists, date: "2026-10-13" });
  assert.equal(changed, true);
  assert.deepEqual(table.milliseconds, {
    "tests/a.test.js": 2500, // max of the two receipts, over the old value
    "tests/b.test.js": 2000, // absent from receipts: preserved
    "tests/c.test.js": 4000, // newly measured
    // tests/gone.test.js dropped: no longer in the tree, despite a receipt value
  });
  assert.deepEqual(Object.keys(table.milliseconds), [...Object.keys(table.milliseconds)].sort(),
    "milliseconds keys are sorted for minimal deterministic diffs");
  assert.equal(table._note, "keep me", "non-milliseconds provenance keys are preserved");
  assert.equal(table[PROVENANCE_KEY].date, "2026-10-13");
  assert.deepEqual(table[PROVENANCE_KEY].runIds, ["run-1"]);
  assert.deepEqual(table[PROVENANCE_KEY].revisions, ["rev-1"]);
  assert.equal(table[PROVENANCE_KEY].filesMeasured, 2);
});

test("refresh: CLI regeneration is idempotent (second run is a byte-identical no-op)", (t) => {
  const fixture = makeTree(t, {
    files: ["tests/a.test.js"],
    milliseconds: { "tests/a.test.js": 1000 },
  });
  copyScript(fixture);
  writeReceipt(fixture.receiptsDir, "unit-shard-1-of-3-attempt-1.json", {
    index: 1, runId: "42", revision: "abc",
    fileDurationsMs: { "tests/a.test.js": 1234 },
  });
  const first = runRefresh(t, fixture);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const afterFirst = readFileSync(fixture.outPath, "utf8");
  assert.equal(JSON.parse(afterFirst).milliseconds["tests/a.test.js"], 1234);
  assert.match(first.stdout, /refreshed/);
  const second = runRefresh(t, fixture);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /no change/);
  assert.equal(readFileSync(fixture.outPath, "utf8"), afterFirst, "second run leaves the file byte-identical");
});

test("refresh: malformed receipts fail closed and write nothing", (t) => {
  const fixture = makeTree(t, {
    files: ["tests/a.test.js"],
    milliseconds: { "tests/a.test.js": 1000 },
  });
  copyScript(fixture);
  const before = readFileSync(fixture.outPath, "utf8");
  writeReceipt(fixture.receiptsDir, "unit-shard-1-of-3-attempt-1.json", "{ not json");
  const badJson = runRefresh(t, fixture);
  assert.notEqual(badJson.status, 0);
  assert.match(badJson.stderr + badJson.stdout, /not valid JSON/);
  assert.equal(readFileSync(fixture.outPath, "utf8"), before);

  writeReceipt(fixture.receiptsDir, "unit-shard-1-of-3-attempt-1.json", {
    fileDurationsMs: { "tests/a.test.js": "fast" },
  });
  assert.throws(() => loadReceipts(fixture.receiptsDir), /malformed fileDurationsMs value/);
  const badValue = runRefresh(t, fixture);
  assert.notEqual(badValue.status, 0);
  assert.equal(readFileSync(fixture.outPath, "utf8"), before, "malformed values never reach the table");
});

test("refresh: receipts without fileDurationsMs leave the table unchanged", (t) => {
  const fixture = makeTree(t, {
    files: ["tests/a.test.js"],
    milliseconds: { "tests/a.test.js": 1000 },
    extra: { _note: "keep me" },
  });
  copyScript(fixture);
  writeReceipt(fixture.receiptsDir, "unit-shard-1-of-3-attempt-1.json", {
    index: 1, runId: "7", revision: "rev", elapsedMs: 5000,
    // no fileDurationsMs: a legacy receipt
  });
  const before = readFileSync(fixture.outPath, "utf8");
  const run = runRefresh(t, fixture);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /no change/);
  assert.equal(readFileSync(fixture.outPath, "utf8"), before);
  assert.equal(existsSync(fixture.outPath), true);
  const { changed } = refreshTable(fixture.table, [JSON.parse(readFileSync(join(fixture.receiptsDir, "unit-shard-1-of-3-attempt-1.json"), "utf8"))], {});
  assert.equal(changed, false);
});

test("junit parsing sums per-file testcase times and handles suite-grouped files without double counting", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
\t<testcase name="one" time="0.010" classname="test" file="/repo/tests/a.test.js"/>
\t<testcase name="two" time="0.020" classname="test" file="/repo/tests/a.test.js"/>
\t<testsuite name="suite" time="9.999" disabled="0" errors="0" tests="1" failures="0">
\t\t<testcase name="inner" time="0.005" classname="test" file="/repo/tests/b.test.js"/>
\t</testsuite>
\t<testsuite name="tests/c.test.js" time="1.5">
\t</testsuite>
</testsuites>
`;
  assert.deepEqual(parseJunitFileDurations(xml, { cwd: "/repo" }), {
    "tests/a.test.js": 30,
    "tests/b.test.js": 5, // the enclosing suite's 9.999s is not double counted
    "tests/c.test.js": 1500, // file-named suite with no testcases uses its own time
  });
  assert.deepEqual(parseJunitFileDurations(""), {});
  assert.deepEqual(parseJunitFileDurations("not xml at all"), {});
});

test("unmeasured default is the median of measured durations, floored at 5000ms", () => {
  assert.equal(unmeasuredDefaultMs([1000, 2000, 3000]), 5000, "a low median is floored");
  assert.equal(unmeasuredDefaultMs([1000, 9000, 20000]), 9000);
  assert.equal(unmeasuredDefaultMs([10000, 20000]), 15000, "even counts average the middle pair");
  assert.equal(unmeasuredDefaultMs([]), 5000);
  assert.equal(unmeasuredDefaultMs([Number.NaN, -1, 0]), 5000, "non-positive and non-finite values are ignored");
  const actual = unmeasuredDefaultMs();
  assert.ok(actual >= 5000, "the committed table's default is at least the floor");
});
