import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/deploy-prod.yml", import.meta.url), "utf8"));
const gate = workflow.jobs.gate.steps.find(step => step.id === "gate").run;
// Execute the workflow's actual policy shell, with real jq and fixture API data.
const policy = gate.slice(gate.indexOf("for wf in test schema-gate; do"), gate.indexOf('if [ "$EVENT" != "workflow_dispatch" ]; then', gate.indexOf("for wf in test schema-gate; do")));
function check(event, tests, schema) {
  const dir = mkdtempSync(join(tmpdir(), "room-deploy-policy-"));
  try {
    writeFileSync(join(dir, "runs.json"), JSON.stringify({ workflow_runs: [
      ...[ ["test", tests], ["schema-gate", schema] ].filter(([, result]) => result !== "missing").map(([name, result]) => ({ name, conclusion: result === "in_progress" ? null : result, status: result, created_at: "2026-10-19T00:00:00Z" }))
    ] }));
    const summary = join(dir, "summary");
    const result = spawnSync("bash", ["-c", 'set -euo pipefail\nskip() { echo "SKIP:$1"; exit 0; }\nrefuse() { echo "REFUSE:$1"; exit 1; }\n' + policy + '\necho ALLOW'], {
      cwd: dir, encoding: "utf8", env: { ...process.env, EVENT: event, SHA: "a".repeat(40), GITHUB_STEP_SUMMARY: summary }
    });
    return { ...result, summary: readFileSync(summary, "utf8") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
for (const status of ["success", "failure", "cancelled", "in_progress", "missing"]) {
  test(`manual dispatch records advisory test=${status} with schema success`, () => {
    const result = check("workflow_dispatch", status, "success");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ALLOW/);
    assert.ok(result.summary.includes(`: ${status}`));
    if (status !== "success") assert.match(result.stdout, /::warning/);
  });
  test(`automatic deployment requires successful test=${status}`, () => {
    const result = check("workflow_run", status, "success");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, status === "success" ? /ALLOW/ : /SKIP:/);
    if (status !== "success") assert.doesNotMatch(result.stdout, /ALLOW/);
  });
}
for (const status of ["failure", "cancelled", "in_progress", "missing"]) {
  test(`schema=${status} blocks manual and automatic deployments`, () => {
    const manual = check("workflow_dispatch", "failure", status);
    assert.equal(manual.status, 1, manual.stderr);
    assert.match(manual.stdout, /REFUSE:.*schema-gate/);
    assert.doesNotMatch(manual.stdout, /ALLOW/);
    const automatic = check("workflow_run", "success", status);
    assert.equal(automatic.status, 0, automatic.stderr);
    assert.match(automatic.stdout, /SKIP:.*schema-gate/);
    assert.doesNotMatch(automatic.stdout, /ALLOW/);
  });
}
