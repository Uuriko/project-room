// 200-hard-tasks #84: self-dogfood harness CI wrapper.
// Runs scripts/self-dogfood.mjs (10 user journeys, each with a named
// failure mode) as a single test. The harness itself boots a disposable
// in-process room; this wrapper just asserts it exits 0.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

test("self-dogfood: all 10 user journeys pass against a local room", t => {
  const res = spawnSync(process.execPath, [join(repo, "scripts/self-dogfood.mjs"), "--json"], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, TMPDIR: join(repo, ".tmp") },
  });
  let report = null;
  try { report = JSON.parse(res.stdout); } catch {}
  const summary = report
    ? report.journeys.map(j => `${j.pass ? "PASS" : "FAIL"} ${j.name}${j.pass ? "" : ` [${j.failureMode}]`}`).join("\n")
    : res.stdout.slice(-2000);
  assert.equal(res.status, 0, `self-dogfood failed:\n${summary}\n${res.stderr.slice(-2000)}`);
}, { timeout: 150000 });
