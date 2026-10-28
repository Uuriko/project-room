import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { findBlockingRuns } from "../scripts/deploy-concurrency-guard.mjs";

const cli = fileURLToPath(new URL("../scripts/deploy-concurrency-guard.mjs", import.meta.url));
const run = (id, status, name = "deploy-prod") => ({ id, status, name, html_url: `https://example.test/runs/${id}` });

test("only another in_progress production run blocks publication", () => {
  const payloads = [
    { workflow_runs: [run(11, "in_progress"), run(12, "completed"), run(13, "queued")] },
    { workflow_runs: [run(14, "in_progress", "rollback-prod")] },
  ];
  // Self (11) never blocks itself; completed/queued runs are not publishing.
  assert.deepEqual(findBlockingRuns(payloads, "11").map(r => r.id), [14]);
  assert.deepEqual(findBlockingRuns(payloads, 99).map(r => r.id), [11, 14]);
  assert.deepEqual(findBlockingRuns([{ workflow_runs: [run(11, "in_progress")] }], "11"), []);
  assert.deepEqual(findBlockingRuns([], "11"), []);
  // Bare-array payloads (a saved `gh api` page shape) are accepted too.
  assert.deepEqual(findBlockingRuns([[run(15, "in_progress")]], "11").map(r => r.id), [15]);
});

function runCli(t, payloads, self) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = payloads.map((payload, i) => {
    const file = join(dir, `runs-${i}.json`);
    writeFileSync(file, JSON.stringify(payload));
    return file;
  });
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, "--self", String(self), ...files], { timeout: 15000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

test("CLI exits 0 when no other production run is in progress", async t => {
  const result = await runCli(t, [{ workflow_runs: [run(11, "in_progress"), run(12, "queued")] }], 11);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /no other production run in progress/);
});

test("CLI exits 1 and names the blocking run", async t => {
  const result = await runCli(t, [
    { workflow_runs: [run(11, "in_progress")] },
    { workflow_runs: [run(21, "in_progress", "rollback-prod")] },
  ], 11);
  assert.equal(result.code, 1);
  assert.match(result.stdout + result.stderr, /21/);
  assert.match(result.stdout + result.stderr, /rollback-prod/);
});
