import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeCheckpoint, checkpointMarkdown } from "../scripts/release-checkpoint.mjs";

// Contract owner: a checkpoint must not turn changed revisions, absent checks,
// public HTTP success, or missing evidence into release readiness. Existing
// release-evidence tests cover TAP/digests; these cover PR/version observations.
const HEAD = "a".repeat(40), BASE = "b".repeat(40), OTHER = "c".repeat(40);
const AT = "2026-09-26T01:00:00.000Z";
const snapshot = value => ({ checkedAt: AT, value });
const passed = { __typename: "CheckRun", name: "unit", workflowName: "test", status: "COMPLETED", conclusion: "SUCCESS", completedAt: AT };
function observations() {
  const metadata = { headRefOid: HEAD, baseRefOid: BASE, baseRefName: "main", state: "OPEN", mergeStateStatus: "CLEAN" };
  return { checkedAt: AT, repository: "Uuriko/project-room", prNumber: 42,
    before: snapshot({ ...metadata }), checks: snapshot({ headRefOid: HEAD, statusCheckRollup: [{ ...passed }] }), after: snapshot({ ...metadata }),
    doors: [{ origin: "https://room.example", checkedAt: AT, httpStatus: 200, value: { sourceRevision: HEAD, buildId: "build-1" } }] };
}

test("checkpoint separates observed checks, reported revision, and unperformed authenticated proof", () => {
  const input = observations(); input.expectedRevision = OTHER;
  input.doors.push({ origin: "https://entry.example/room", checkedAt: AT, httpStatus: 200, value: { sourceRevision: OTHER, buildId: "build-2", secret: "must-not-be-output" } });
  const report = summarizeCheckpoint(input);
  assert.equal(report.pullRequest.checks.state, "passed");
  assert.equal(report.pullRequest.checks.requiredChecksEvaluated, false);
  assert.equal(report.authenticatedProbe, "not_performed");
  assert.equal(report.pullRequest.checks.integrationBaseVerified, false);
  assert.deepEqual(report.doors.map(row => [row.reachable, row.revisionMatch]), [[true, "mismatch"], [true, "match"]]);
  assert.equal(JSON.stringify(report).includes("must-not-be-output"), false);
  assert.match(checkpointMarkdown(report), /HTTP 200 means public version endpoint reachability only/);
  assert.match(checkpointMarkdown(report), /release-evidence\.mjs/);
});

test("current-head checks stay unknown if either snapshot moves or check attribution is stale", () => {
  for (const [change, reason] of [
    [input => { input.after.value.headRefOid = OTHER; }, "head_changed"],
    [input => { input.after.value.baseRefOid = OTHER; }, "base_changed"],
    [input => { input.after.value.baseRefName = "release"; }, "base_changed"],
    [input => { input.checks.value.headRefOid = OTHER; }, "checks_not_for_head"],
    [input => { input.after = { checkedAt: AT, error: "github_timeout" }; }, "observation_failed"]
  ]) {
    const input = observations(); change(input);
    const report = summarizeCheckpoint(input);
    assert.equal(report.pullRequest.checks.state, "unknown", reason);
    assert.equal(report.pullRequest.checks.reason, reason);
  }
});

test("empty, pending, failed, skipped-only and unrecognized check results never become passed", () => {
  for (const [rows, state, reason] of [
    [[], "incomplete", "no_checks"],
    [[{ ...passed, status: "IN_PROGRESS", conclusion: "" }], "incomplete", "checks_pending"],
    [[{ ...passed, conclusion: "FAILURE" }], "failed", "check_failed"],
    [[{ ...passed, conclusion: "SKIPPED" }], "incomplete", "no_passing_checks"],
    [[{ ...passed, conclusion: "STALE" }], "unknown", "check_status_unknown"],
    [[{ __typename: "StatusContext", context: "external", state: "PENDING" }], "incomplete", "checks_pending"],
    [[{ __typename: "StatusContext", context: "external", state: "ERROR" }], "failed", "check_failed"],
    [[{ __typename: "NewCheckKind", state: "SUCCESS" }], "unknown", "check_status_unknown"]
  ]) {
    const input = observations(); input.checks.value.statusCheckRollup = rows;
    const checks = summarizeCheckpoint(input).pullRequest.checks;
    assert.equal(checks.state, state, reason); assert.equal(checks.reason, reason);
  }
  for (const conclusion of ["NEUTRAL", "SKIPPED"]) {
    const input = observations(); input.checks.value.statusCheckRollup.push({ ...passed, name: "another check", conclusion });
    const checks = summarizeCheckpoint(input).pullRequest.checks;
    assert.equal(checks.state, "passed_with_skips");
    assert.equal(checks.rows[1].status, "not_run", "neutral/skipped result is retained without assuming it is optional");
  }
});

test("HTTP success without a full source revision remains unmatched; transport failures retain their status", () => {
  const input = observations(); input.expectedRevision = HEAD;
  input.doors = [
    { origin: "https://one.example", checkedAt: AT, httpStatus: 200, value: { sourceRevision: "short", buildId: "opaque" } },
    { origin: "https://two.example", checkedAt: AT, httpStatus: 500, error: "http_error" },
    { origin: "https://three.example", checkedAt: AT, error: "request_timeout" },
    { origin: "https://four.example", checkedAt: AT, httpStatus: 200, error: "invalid_json" }
  ];
  const doors = summarizeCheckpoint(input).doors;
  assert.deepEqual(doors.map(row => row.revisionMatch), ["unknown", "unknown", "unknown", "unknown"]);
  assert.deepEqual(doors.map(row => row.reachable), [true, false, false, true]);
  assert.deepEqual(doors.map(row => row.error), [null, "http_error", "request_timeout", "invalid_json"]);
  input.expectedRevision = null;
  assert.equal(summarizeCheckpoint(input).doors[0].revisionMatch, "not_requested");
});

test("Markdown renders provider strings as text", () => {
  const input = observations(); input.checks.value.statusCheckRollup[0].name = "<script>[click](https://evil.example)";
  input.checks.value.statusCheckRollup[0].detailsUrl = "https://github.com/Uuriko/project-room/actions/runs/1/job/2";
  input.checks.value.statusCheckRollup.push({ ...passed, detailsUrl: "https://user:secret@provider.example/?token=secret" });
  const report = summarizeCheckpoint(input);
  assert.equal(report.pullRequest.checks.rows[0].detailsUrl, "https://github.com/Uuriko/project-room/actions/runs/1/job/2");
  assert.equal(report.pullRequest.checks.rows[1].detailsUrl, null);
  const markdown = checkpointMarkdown(report);
  assert.equal(markdown.includes("<script>"), false);
  assert.equal(markdown.includes("[click](https://evil.example)"), false);
});

const cli = fileURLToPath(new URL("../scripts/release-checkpoint.mjs", import.meta.url));
test("CLI refuses unsafe origins and partial revisions before collecting or writing", t => {
  const directory = mkdtempSync(join(tmpdir(), "checkpoint-invalid-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const extra of [["--origin", "http://room.example"], ["--origin", "https://user:secret@room.example"],
    ["--origin", "https://room.example?token=secret"], ["--expected-revision", "abcd1234"], ["--unknown", "value"]]) {
    assert.throws(() => execFileSync(process.execPath, [cli, "--pr", "42", "--output", join(directory, "out"), ...extra], { stdio: "pipe" }), error => {
      assert.equal(error.status, 2); assert.equal(error.stderr.toString().includes("secret"), false); return true;
    });
    assert.equal(existsSync(join(directory, "out")), false);
  }
});

test("CLI re-reads the head after collecting checks and writes only explicitly requested files", t => {
  const directory = mkdtempSync(join(tmpdir(), "checkpoint-cli-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin"); mkdirSync(bin);
  const input = observations(); input.after.value.headRefOid = OTHER;
  const fixtures = [input.before.value, input.checks.value, input.after.value];
  const counter = join(directory, "count");
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\nimport * as fs from 'node:fs'; const file=${JSON.stringify(counter)}; const n=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0; const rows=${JSON.stringify(fixtures)}; if(n>=rows.length)process.exit(3); fs.writeFileSync(file,String(n+1)); process.stdout.write(JSON.stringify(rows[n]));\n`, { mode: 0o700 });
  const output = join(directory, "output");
  // A real refused local TLS connection exercises error collection without
  // external service traffic or a fetch double.
  assert.throws(() => execFileSync(process.execPath, [cli, "--pr", "42", "--origin", "https://127.0.0.1:1", "--output", output], {
    cwd: directory, env: { ...process.env, PATH: bin }, stdio: "pipe", timeout: 15000
  }), error => { assert.equal(error.status, 1); assert.equal(error.stdout.toString(), ""); return true; });
  const report = JSON.parse(readFileSync(join(output, "release-checkpoint.json"), "utf8"));
  assert.equal(report.pullRequest.checks.reason, "head_changed");
  assert.equal(report.pullRequest.finalHeadRevision, OTHER);
  assert.equal(report.doors[0].error, "request_failed");
  assert.equal(readFileSync(counter, "utf8"), "3");
  assert.match(readFileSync(join(output, "release-checkpoint.md"), "utf8"), /head_changed/);
});
