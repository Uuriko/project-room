import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";

// Execute the workflow shell against the documented CLI contract. The fixture
// refuses unsupported commands/flags, including any attempted bot merge.
test("trace workflow creates or reuses a PR and leaves landing to review", t => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/trace-entry.yml", import.meta.url), "utf8"));
  const step = workflow.jobs["trace-pr"].steps.find(s => s.env?.TRACE_BRANCH);
  assert.ok(step);
  const dir = mkdtempSync(join(tmpdir(), "trace-workflow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin"), log = join(dir, "calls.jsonl"), summary = join(dir, "summary");
  mkdirSync(bin);
  writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}');
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require('node:fs'), a = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(a) + '\\n');
if (a[0] !== 'pr') throw new Error('unexpected command');
if (a[1] === 'list') console.log(process.env.EXISTING_PR || '');
else if (a[1] === 'create') {
  if (a.includes('--json') || a.includes('--jq')) throw new Error('unsupported create option');
  if (process.env.CREATE_FAIL === '1') process.exit(1);
  console.log('https://github.com/Uuriko/project-room/pull/9000');
} else if (a[1] === 'view' && a[2] === 'https://github.com/Uuriko/project-room/pull/9000') console.log('9000');
else throw new Error('unexpected command, including forbidden merge');
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log,
    DEFAULT_BRANCH: "main", TRACE_BRANCH: "trace-entry/pr-42", PR_NUMBER: "42", GITHUB_STEP_SUMMARY: summary,
    EXISTING_PR: "", CREATE_FAIL: "" };
  for (const existing of ["", "8123"]) {
    rmSync(log, { force: true }); rmSync(summary, { force: true });
    execFileSync("bash", ["-c", step.run], { cwd: dir, env: { ...env, EXISTING_PR: existing } });
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls.map(c => c[1]), existing ? ["list"] : ["list", "create", "view"]);
    assert.match(readFileSync(summary, "utf8"), new RegExp(`#${existing || "9000"} prepared; independent review and shared landing required`));
  }
  rmSync(log, { force: true }); rmSync(summary, { force: true });
  assert.throws(() => execFileSync("bash", ["-c", step.run], { cwd: dir, env: { ...env, CREATE_FAIL: "1" }, stdio: "pipe" }));
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map(JSON.parse).map(c => c[1]), ["list", "create"]);
  assert.throws(() => readFileSync(summary), { code: "ENOENT" });
});
