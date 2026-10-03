// The pre-deploy onboarding gate (ACT-5b) blocks a deploy when the staging
// probe regresses, unless an override with a reason is given, and the
// deploy-prod lane only ships after the gate passes or is switched off.
// The CLI cases run the real script as a child process against a local
// version endpoint with a stub probe runner, so the exit code is the one the
// workflow sees.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseArgs, predeploy, resolveTarget, waitForSha } from "../scripts/onboarding-probe/predeploy.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/onboarding-probe/predeploy.mjs", import.meta.url));
const baseline = JSON.parse(readFileSync(new URL("../docs/onboarding-probe/baseline.json", import.meta.url), "utf8"));
const SHA = "a".repeat(40);

function result(firstPostMs) {
  const agentDocs = { closeReachable: false, firstPost: { t: firstPostMs, calls: 5 }, firstClose: null, steps: [] };
  return { ready: { medianMs: 100, inconclusive: false }, runs: [1, 2, 3].map(() => ({ paths: { agentDocs } })) };
}

test("a regression past 20% fails the gate and names the path and step", async () => {
  const lines = [];
  const { code, record } = await predeploy({ origin: "https://stage.example", runs: 3, baseline, runProbe: async () => result(1000), log: line => lines.push(line) });
  assert.equal(code, 1);
  assert.equal(record.verdict, "fail");
  assert.deepEqual(record.failures, [{ path: "agentDocs", step: "firstPost", reason: "slower" }]);
  assert.ok(lines.includes("fail agentDocs firstPost slower"), lines.join("\n"));
});

test("an override with a reason lets a failing gate through and records the reason", async () => {
  const lines = [];
  const { code, record } = await predeploy({ origin: "https://stage.example", baseline, override: "hotfix for login outage", runProbe: async () => result(1000), log: line => lines.push(line) });
  assert.equal(code, 0);
  assert.equal(record.verdict, "overridden");
  assert.equal(record.override, "hotfix for login outage");
  assert.equal(record.failures.length, 1);
  assert.ok(lines.includes("override recorded: hotfix for login outage"));
});

test("a run on the baseline passes", async () => {
  const { code, record } = await predeploy({ origin: "https://stage.example", baseline, runProbe: async () => result(770), log: () => {} });
  assert.equal(code, 0);
  assert.equal(record.verdict, "pass");
});

test("a target that never reports the commit fails without probing", async () => {
  let probed = false;
  const { code, record } = await predeploy({
    origin: "https://stage.example", sha: SHA, baseline, log: () => {},
    runProbe: async () => { probed = true; return result(770); },
    waitForTarget: async () => ({ ok: false, seen: "b".repeat(40) }),
  });
  assert.equal(code, 1);
  assert.equal(probed, false);
  assert.equal(record.failures[0].path, "target");
});

test("a probe runner that crashes fails the gate", async () => {
  const { code, record } = await predeploy({ origin: "https://stage.example", baseline, log: () => {}, runProbe: async () => { throw new Error("probe runner exited 3"); } });
  assert.equal(code, 1);
  assert.equal(record.failures[0].reason, "probe runner exited 3");
});

test("flags: a blank override, a short sha and unknown flags are refused; staging resolves from the env", () => {
  assert.throws(() => parseArgs(["--override", "  "]), /needs a reason/);
  assert.throws(() => parseArgs(["--sha", "abc123"]), /40-character/);
  assert.throws(() => parseArgs(["--force"]), /unknown flag/);
  assert.equal(parseArgs(["--target", "staging"]).runs, 3);
  assert.equal(resolveTarget("staging", { ROOM_STAGING_ORIGIN: "https://stage.example/" }), "https://stage.example");
  assert.equal(resolveTarget("staging", {}), "https://project-room-stage.getdasha.workers.dev");
  assert.throws(() => resolveTarget("prod", {}), /staging/);
});

test("waitForSha polls until the target reports the commit or the wait runs out", async () => {
  let clock = 0;
  const seen = [null, "b".repeat(40), SHA];
  const ok = await waitForSha("https://stage.example", SHA, { waitMs: 100, intervalMs: 10, fetchVersion: async () => seen.shift() ?? SHA, sleep: async ms => { clock += ms; }, now: () => clock });
  assert.deepEqual(ok, { ok: true, seen: SHA });
  clock = 0;
  const late = await waitForSha("https://stage.example", SHA, { waitMs: 30, intervalMs: 10, fetchVersion: async () => "c".repeat(40), sleep: async ms => { clock += ms; }, now: () => clock });
  assert.equal(late.ok, false);
});

async function withVersionServer(sha, fn) {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/api/version" ? { sourceRevision: sha } : {}));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function stubRunner(dir, firstPostMs) {
  const file = join(dir, `stub-${firstPostMs}.mjs`);
  writeFileSync(file, `import { mkdirSync, writeFileSync } from "node:fs";
const out = process.argv[process.argv.indexOf("--out") + 1];
mkdirSync(out, { recursive: true });
writeFileSync(out + "/probe-result.json", ${JSON.stringify(JSON.stringify(result(firstPostMs)))});
`);
  return file;
}

// Async spawn: the version server lives in this process, so a synchronous
// spawn would block it from answering.
function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, GITHUB_STEP_SUMMARY: "", GITHUB_OUTPUT: "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
}

test("CLI: the deploy step exits 1 on a failing gate and writes the verdict and step outputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "predeploy-"));
  await withVersionServer(SHA, async origin => {
    const out = join(dir, "fail");
    const outputs = join(dir, "gh-output");
    writeFileSync(outputs, "");
    const run = await runCli(["--target", origin, "--sha", SHA, "--out", out, "--runner", stubRunner(dir, 1000), "--wait-ms", "1000"], { GITHUB_OUTPUT: outputs });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /onboarding predeploy gate: fail/);
    assert.match(run.stdout, /fail agentDocs firstPost slower/);
    assert.equal(JSON.parse(readFileSync(join(out, "predeploy.json"), "utf8")).verdict, "fail");
    assert.match(readFileSync(outputs, "utf8"), /^verdict=fail$/m);

    const over = await runCli(["--target", origin, "--sha", SHA, "--out", join(dir, "over"), "--runner", stubRunner(dir, 1000), "--override", "known slow docs host", "--wait-ms", "1000"], { GITHUB_OUTPUT: outputs });
    assert.equal(over.status, 0, over.stdout + over.stderr);
    assert.match(readFileSync(outputs, "utf8"), /^override=known slow docs host$/m);

    const pass = await runCli(["--target", origin, "--sha", SHA, "--out", join(dir, "pass"), "--runner", stubRunner(dir, 770), "--wait-ms", "1000"]);
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  });
  await withVersionServer("b".repeat(40), async origin => {
    const stale = await runCli(["--target", origin, "--sha", SHA, "--out", join(dir, "stale"), "--runner", stubRunner(dir, 770), "--wait-ms", "200"]);
    assert.equal(stale.status, 1, stale.stdout + stale.stderr);
    assert.match(stale.stdout, /fail target version/);
  });
  const blank = await runCli(["--override", ""]);
  assert.equal(blank.status, 2);
});

test("deploy-prod runs the deploy only after the onboarding gate passes or is switched off", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/deploy-prod.yml", import.meta.url), "utf8"));
  const { probe, deploy, gate } = workflow.jobs;
  assert.ok(gate, "dual-green gate job is still present");
  assert.deepEqual(probe.needs, "gate");
  assert.match(probe.if, /vars\.ROOM_ONBOARDING_GATE == '1'/);
  assert.match(probe.if, /needs\.gate\.outputs\.go == 'true'/);
  const step = probe.steps.find(s => s.id === "predeploy");
  assert.match(step.run, /predeploy\.mjs --target staging --sha "\$SHA"/);
  assert.ok(!/\$\{\{\s*inputs\./.test(step.run), "workflow inputs reach the shell only through env");
  assert.deepEqual(deploy.needs, ["gate", "probe"]);
  assert.match(deploy.if, /needs\.gate\.outputs\.go == 'true'/);
  assert.match(deploy.if, /needs\.probe\.result == 'success' \|\| needs\.probe\.result == 'skipped'/);
  assert.ok(workflow.on.workflow_dispatch.inputs.probe_override);
});
