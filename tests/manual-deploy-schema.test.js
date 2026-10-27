import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/deploy-prod.yml", import.meta.url), "utf8"));
const script = workflow.jobs.gate.steps.find(step => step.id === "gate").run;
const gitBin = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "manual-schema-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "repo"), bin = join(root, "bin");
  mkdirSync(join(cwd, "scripts/schema-gate"), { recursive: true }); mkdirSync(bin);
  const git = args => execFileSync(gitBin, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  // The actual workflow shell runs a harness at the selected commit. Its
  // controlled failure and trace distinguish qualification from a status claim.
  const harness = version => `import {appendFileSync,readFileSync} from 'node:fs';
appendFileSync(process.env.TRACE,JSON.stringify({version:${JSON.stringify(version)},output:readFileSync(process.env.GITHUB_OUTPUT,'utf8')})+'\\n');
console.log('schema fixture ${version}');process.exit(Number(process.env.SCHEMA_EXIT||0));\n`;
  writeFileSync(join(cwd, "scripts/schema-gate/schema-gate.mjs"), harness("target"));
  writeFileSync(join(cwd, "scripts/check-version-doors.mjs"), "process.exit(1);\n");
  git(["add", "."]); git(["commit", "-qm", "target"]); const target = git(["rev-parse", "HEAD"]);
  writeFileSync(join(cwd, "scripts/schema-gate/schema-gate.mjs"), harness("wrong-tip"));
  git(["commit", "-qam", "tip"]); const tip = git(["rev-parse", "HEAD"]);
  git(["remote", "add", "origin", cwd]);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat "$RUNS_FILE"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "git"), `#!/bin/sh\nif [ "$1" = checkout ] && [ "$IGNORE_CHECKOUT" = 1 ]; then exit 0; fi\nexec "${gitBin}" "$@"\n`, { mode: 0o755 });
  symlinkSync(process.execPath, join(bin, "node"));
  const trace = join(root, "trace"), output = join(root, "output"), summary = join(root, "summary"), runs = join(root, "runs.json");
  return { git, target, tip, cwd, run({ event = "workflow_dispatch", sha = target, schemaExit = 0, ignoreCheckout = false, conclusions = {} } = {}) {
    writeFileSync(output, ""); writeFileSync(summary, ""); writeFileSync(trace, "");
    writeFileSync(runs, JSON.stringify({ workflow_runs: Object.entries(conclusions).map(([name, conclusion]) => ({ name, conclusion, created_at: "2026-10-27T00:00:00Z" })) }));
    const result = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env: { ...process.env,
      PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, EVENT: event, INPUT_SHA: sha, RUN_SHA: sha,
      REPO: "fixture/repo", PROD_ORIGIN: "https://fixture.invalid", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, TRACE: trace,
      RUNS_FILE: runs, SCHEMA_EXIT: String(schemaExit), IGNORE_CHECKOUT: ignoreCheckout ? "1" : "0" } });
    return { ...result, output: readFileSync(output, "utf8"), summary: readFileSync(summary, "utf8"), trace: readFileSync(trace, "utf8") };
  } };
}

test("manual deployment runs the exact target harness before granting go, independent of hosted queue", t => {
  const f = fixture(t), r = f.run({ conclusions: { test: "failure", "schema-gate": "queued" } });
  assert.equal(r.status, 0, r.stderr); assert.match(r.output, /go=true/);
  assert.equal(f.git(["rev-parse", "HEAD"]), f.target);
  const trace = JSON.parse(r.trace); assert.equal(trace.version, "target"); assert.doesNotMatch(trace.output, /go=true/);
  assert.match(r.summary, /schema fixture target/); assert.match(r.summary, new RegExp(`Inline schema qualification passed on ${f.target}`));
});

test("manual deployment fails closed on schema error and retains output", t => {
  const r = fixture(t).run({ schemaExit: 7 });
  assert.equal(r.status, 7); assert.doesNotMatch(r.output, /go=true/); assert.match(r.summary, /schema fixture target/);
  assert.doesNotMatch(r.summary, /Inline schema qualification passed/);
});

test("manual deployment refuses a wrong checkout even when checkout reports success", t => {
  const r = fixture(t).run({ ignoreCheckout: true });
  assert.notEqual(r.status, 0); assert.match(r.stdout, /checkout does not match/); assert.equal(r.trace, ""); assert.doesNotMatch(r.output, /go=true/);
});

test("manual deployment refuses invalid and off-main targets before schema execution", t => {
  const f = fixture(t);
  let r = f.run({ sha: "not-a-commit" }); assert.notEqual(r.status, 0); assert.equal(r.trace, "");
  f.git(["checkout", "-qb", "outside", f.target]); writeFileSync(join(f.cwd, "outside"), "not main");
  f.git(["add", "."]); f.git(["commit", "-qm", "outside"]); const outside = f.git(["rev-parse", "HEAD"]); f.git(["checkout", "-q", "main"]);
  r = f.run({ sha: outside }); assert.notEqual(r.status, 0); assert.match(r.stdout, /not on main/); assert.equal(r.trace, ""); assert.doesNotMatch(r.output, /go=true/);
});

test("automatic deployment still requires both hosted gates and never invokes inline schema", t => {
  const f = fixture(t);
  for (const conclusions of [{}, { test: "success", "schema-gate": "failure" }, { test: "queued", "schema-gate": "success" }]) {
    const r = f.run({ event: "workflow_run", sha: f.tip, conclusions });
    assert.equal(r.status, 0, r.stderr); assert.match(r.output, /go=false/); assert.equal(r.trace, "");
  }
  const r = f.run({ event: "workflow_run", sha: f.tip, conclusions: { test: "success", "schema-gate": "success" } });
  assert.equal(r.status, 0, r.stderr); assert.match(r.output, /go=true/); assert.equal(r.trace, "");
});
