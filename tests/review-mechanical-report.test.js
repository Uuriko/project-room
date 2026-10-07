// Owner-boundary tests for scripts/review-mechanical-report.mjs.
// The contract: renderReport() emits a stable machine-readable JSON shape
// (check/stage/pr/head/lint/tests/files_changed/lines/scope/generated_at)
// inside a markdown block marked with <!-- review-mechanical-report -->.
// Reviewers and tooling read that JSON; a dropped field or a lost marker
// silently breaks the clean-context judgment pass.
import test from "node:test";
import assert from "node:assert/strict";
import { renderReport } from "../scripts/review-mechanical-report.mjs";

function sampleScope(overrides = {}) {
  return {
    verdict: "clean",
    changedCount: 3,
    drift: [],
    declared: ["a.mjs"],
    ...overrides,
  };
}

test("report JSON carries the full machine-readable contract", () => {
  const { report } = renderReport({
    stage: "full",
    pr: "1585",
    head: "abc123",
    lint: "success",
    tests: "success",
    additions: "120",
    deletions: "30",
    scope: sampleScope(),
  });
  assert.equal(report.check, "review-mechanical");
  assert.equal(report.stage, "full");
  assert.equal(report.pr, 1585);
  assert.equal(report.head, "abc123");
  assert.equal(report.lint, "success");
  assert.equal(report.tests, "success");
  assert.equal(report.files_changed, 3);
  assert.equal(report.lines_added, 120);
  assert.equal(report.lines_deleted, 30);
  assert.deepEqual(report.scope, { verdict: "clean", drift: [], declared: ["a.mjs"] });
  assert.match(report.generated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("markdown contains the machine-readable marker and a parseable JSON block", () => {
  const { markdown, report } = renderReport({
    stage: "fast",
    pr: 7,
    head: "def456",
    lint: "pending",
    tests: "pending",
    additions: 5,
    deletions: 1,
    scope: sampleScope(),
  });
  assert.ok(markdown.includes("<!-- review-mechanical-report -->"));
  const m = markdown.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(m, "expected a fenced json block");
  assert.deepEqual(JSON.parse(m[1]), report);
});

test("drift verdict surfaces the drifted files in both JSON and markdown", () => {
  const { report, markdown } = renderReport({
    stage: "full",
    pr: 7,
    head: "def456",
    lint: "success",
    tests: "success",
    additions: 5,
    deletions: 1,
    scope: sampleScope({ verdict: "drift", drift: ["server/surprise.mjs"] }),
  });
  assert.equal(report.scope.verdict, "drift");
  assert.deepEqual(report.scope.drift, ["server/surprise.mjs"]);
  assert.ok(markdown.includes("server/surprise.mjs"));
  assert.ok(markdown.includes("scope drift"));
});

test("undeclared verdict tells the reviewer to check scope by hand", () => {
  const { markdown } = renderReport({
    stage: "fast",
    pr: 7,
    head: "def456",
    lint: "pending",
    tests: "pending",
    additions: 5,
    deletions: 1,
    scope: sampleScope({ verdict: "undeclared", declared: [] }),
  });
  assert.ok(markdown.includes("claim-files"));
  assert.ok(markdown.includes("| claim scope | undeclared |"));
});

// GitHub evaluates the YAML and shell, not renderReport alone. This owner
// executes those actual steps with offline gh facts and the real report CLI.
// Restoring PR polling holds a runner; dropping the completed-run head guard
// misattributes stale test results. No production exports or network calls.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = parse(readFileSync(join(root, ".github/workflows/review-mechanical.yml"), "utf8"));

test("PR mechanical review emits only immediate signals; completed test events own final conclusions", () => {
  assert.equal(workflow.name, "review-mechanical");
  assert.equal(workflow.jobs.mechanical.if, "github.event_name == 'pull_request'");
  assert.equal(workflow.jobs.full.if, "github.event_name == 'workflow_run'");
  assert.deepEqual(workflow.on.workflow_run, { workflows: ["test"], types: ["completed"] });
  const fast = workflow.jobs.mechanical.steps.filter(step => step.run);
  assert.equal(fast.length, 1, "the PR path finishes immediately after its fast report");
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) if (step.run) {
      assert.doesNotMatch(step.run, /\bsleep\s|\bwhile\s|gh\s+run\s+(list|watch)/, "review reports must not occupy runners waiting for another workflow");
    }
  }
});

function executeReportJob(t, job, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-review-workflow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, PATH: directory + ":" + process.env.PATH,
    GH_TOKEN: "offline-fixture", PR_NUMBER: "73", CURRENT_FIXTURE_HEAD: "tested-sha",
    RUN_ID: "888", TESTED_SHA: "tested-sha", TEST_CONCLUSION: "failure",
    REPO: "fixture/room", GITHUB_ENV: join(directory,"env"),
    GITHUB_STEP_SUMMARY: join(directory,"summary"), GITHUB_EVENT_PATH: join(directory,"event"), ...overrides };
  writeFileSync(env.GITHUB_ENV, ""); writeFileSync(env.GITHUB_STEP_SUMMARY, "");
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ workflow_run: { pull_requests: [{ number: 73 }] } }));
  writeFileSync(join(directory,"gh"), `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a[0]==='api'){if(!a[1].endsWith('/actions/runs/888/jobs'))throw Error('wrong tested run');console.log('success');}\nelse if(a[0]==='pr'&&a[1]==='view'){const field=a[a.indexOf('--json')+1];const facts={files:'src/room.js',body:'<!-- claim-files: src/room.js -->',headRefOid:process.env.CURRENT_FIXTURE_HEAD,additions:'42',deletions:'7'};if(!(field in facts))throw Error('unexpected PR fact');console.log(facts[field]);}\nelse throw Error('unexpected polling/network command');\n`, { mode: 0o755 });
  // The production step writes fixed /tmp paths; isolate their files while
  // executing its shell and real repository tools unchanged.
  for (const step of job.steps.filter(step => step.run)) {
    if (step.if) {
      const expression = step.if.replace(/env\.([A-Z_]+)/g, (_,key) => JSON.stringify(env[key] ?? ""));
      assert.match(expression, /^[\w\s'"!=&.-]+$/);
      if (!Function(`return (${expression})`)()) continue;
    }
    const run = spawnSync("bash", ["-eo", "pipefail", "-c", step.run.replaceAll("/tmp/", directory + "/")], { cwd: root, env, encoding:"utf8", timeout:10000 });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    for (const line of readFileSync(env.GITHUB_ENV,"utf8").split("\n")) {
      const at=line.indexOf("="); if(at>0) env[line.slice(0,at)]=line.slice(at+1);
    }
  }
  const summary = readFileSync(env.GITHUB_STEP_SUMMARY,"utf8");
  return { env, reports: [...summary.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match=>JSON.parse(match[1])) };
}

test("actual fast step reports current PR metadata without claiming completed tests", t => {
  const { reports }=executeReportJob(t, workflow.jobs.mechanical);
  assert.equal(reports.length,1);
  assert.equal(reports[0].stage,"fast"); assert.equal(reports[0].head,"tested-sha");
  assert.equal(reports[0].pr,73); assert.equal(reports[0].lint,"pending"); assert.equal(reports[0].tests,"pending");
  assert.equal(reports[0].scope.verdict,"clean"); assert.deepEqual(reports[0].scope.declared,["src/room.js"]);
  assert.equal(reports[0].files_changed,1); assert.equal(reports[0].lines_added,42); assert.equal(reports[0].lines_deleted,7);
});

test("actual completed-run report binds conclusions to the tested head and suppresses stale runs", t => {
  const matched=executeReportJob(t,workflow.jobs.full);
  assert.equal(matched.reports.length,1); const report=matched.reports[0];
  assert.equal(report.stage,"full"); assert.equal(report.head,"tested-sha");
  assert.equal(report.tests,"failure"); assert.equal(report.lint,"success");
  assert.equal(report.lines_added,42); assert.equal(report.lines_deleted,7);
  const stale=executeReportJob(t,workflow.jobs.full,{CURRENT_FIXTURE_HEAD:"newer-sha"});
  assert.equal(stale.env.HEAD_MISMATCH,"true"); assert.deepEqual(stale.reports,[]);
});
