import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("write-burst bench prints one JSON line for a throwaway local burst", { timeout: 60_000 }, async () => {
  const { stdout } = await new Promise((resolve, reject) => {
    execFile(process.execPath, ["perf/write-burst-bench.mjs", "--writers", "2", "--each", "2", "--seed", "0"], {
      cwd: root, timeout: 55_000
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
  const lines = stdout.split("\n").filter(line => line.length > 0);
  assert.deepEqual(lines, [lines[0]]);
  const report = JSON.parse(lines[0]);
  assert.equal(report.writes, 4);
  assert.equal(report.writers, 2);
  assert.equal(report.each, 2);
  assert.equal(report.seed, 0);
  assert.equal(report.refused, 0);
  assert.equal(typeof report["writes/s"], "number");
  assert.ok(report["writes/s"] > 0);
  assert.ok(Number.isInteger(report.rowBytes) && report.rowBytes > report.rowBytesBefore);
  assert.ok(report.p50Ms <= report.p95Ms && report.p95Ms <= report.p99Ms);
  for (const key of ["p50Ms", "p95Ms", "p99Ms"]) assert.ok(report[key] >= 0);
});
