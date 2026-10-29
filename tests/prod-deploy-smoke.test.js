import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { generateKeyPair, signCard, signCardJws } from "../server/agent-card-signing.mjs";

import { readinessDetail } from "../scripts/prod-deploy-smoke.mjs";

const script = fileURLToPath(new URL("../scripts/prod-deploy-smoke.mjs", import.meta.url));
const revision = "a".repeat(40);
const smokePaths = ["/api/health", "/api/ready", "/terms", "/privacy", "/"];
const versionPaths = ["/api/version", "/api/version/worker"];
const cardPath = "/.well-known/agent-card.json";

// The CLI verifies every served card against a key the tests must inject —
// they cannot sign for the production pinned key. One keypair signs the
// fixture card; its public half is handed to the CLI through the
// --agent-card-* knobs (flags for the direct tests, SMOKE_AGENT_CARD_* env
// for the workflow-pipeline test, which runs the literal deploy step).
const cardKeyPair = generateKeyPair();
const cardKeyId = "test-card-key-smoke";
const cardAgentId = "project-room";
const buildFixtureCard = () => {
  const card = {
    name: "Test Room",
    description: "prod-deploy-smoke fixture",
    url: null,
    capabilities: { streaming: false },
    skills: [],
    version: "1",
  };
  const signature = signCard({ agentId: cardAgentId, card, privateKey: cardKeyPair.privateKey });
  const withEnvelope = {
    ...card,
    keyId: cardKeyId,
    signatureAgentId: cardAgentId,
    publicKey: cardKeyPair.publicKey,
    cardSignature: signature,
    signedRevision: revision,
  };
  withEnvelope.signatures = [
    signCardJws({ card: withEnvelope, privateKey: cardKeyPair.privateKey, keyId: cardKeyId, jku: "https://example.test/.well-known/jwks.json" }),
  ];
  return withEnvelope;
};
const fixtureCard = buildFixtureCard();

// Exercise the shipped CLI over real HTTP. Unknown paths/methods fail closed,
// so dropping either door's path prefix cannot accidentally pass the fixture.
async function door(t, prefix, failure) {
  const requests = [];
  const responses = new Map([
    ["/api/health", { status: "ok" }],
    ["/api/ready", { status: "ready", emailVerification: "enforced", emailVerificationScope: "durable-object" }],
    ...versionPaths.map(path => [path, { sourceRevision: revision }]),
    ...["/terms", "/privacy", "/"].map(path => [path, "<!doctype html><title>Room</title>"]),
    [cardPath, fixtureCard],
  ].map(([path, body]) => [`${prefix}${path}`, { status: 200, body }]));
  if (failure) responses.set(`${prefix}${failure.path}`, failure);
  const server = createServer((req, res) => {
    requests.push(req.url);
    const response = req.method === "GET" && responses.get(req.url);
    if (!response) {
      res.writeHead(404).end("Unexpected request");
      return;
    }
    const json = typeof response.body !== "string";
    res.writeHead(response.status, { "content-type": json ? "application/json" : "text/html" });
    res.end(json ? JSON.stringify(response.body) : response.body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return { url: `http://127.0.0.1:${server.address().port}${prefix}`, prefix, requests };
}

function runReport(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15000, ...options }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      try {
        resolve({ code: error?.code ?? 0, report: JSON.parse(stdout), stdout, stderr });
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function runSmoke(origin, entry, withSha) {
  const args = [script, "--origin", `${origin.url}/`, "--entry", `${entry.url}/`,
    "--agent-card-public-key", cardKeyPair.publicKey,
    "--agent-card-key-id", cardKeyId,
    "--agent-card-agent-id", cardAgentId,
    // One fetch per door: the production default (10 fetches x 1.5s gaps x 2
    // doors ~ 27s) cannot fit inside the CLI timeout this suite enforces.
    "--agent-card-fetches", "1"];
  if (withSha) args.push("--sha", revision, "--wait-ms", "0");
  return runReport(process.execPath, args);
}

for (const withSha of [false, true]) {
  const mode = withSha ? "with SHA" : "without SHA";
  test(`${mode}: checks both doors and preserves their path prefixes`, async t => {
    const origin = await door(t, "/canonical");
    const entry = await door(t, "/room");
    const { code, report, stderr } = await runSmoke(origin, entry, withSha);
    assert.equal(code, 0, JSON.stringify(report));
    assert.equal(stderr, "");
    assert.equal(report.ok, true);
    assert.equal(report.sha, withSha ? revision : null);
    assert.equal(report.origin, origin.url);
    assert.equal(report.entry, entry.url);
    const paths = [...smokePaths, ...(withSha ? versionPaths : []), cardPath];
    for (const current of [origin, entry]) {
      assert.deepEqual(current.requests.toSorted(), paths.map(path => `${current.prefix}${path}`).toSorted());
    }
    assert.equal(report.checks.length, paths.length * 2);
    assert.ok(report.checks.every(check => check.pass));
  });

  const failures = [
    { path: "/api/ready", status: 200, body: { status: "ready", emailVerification: "relaxed-no-mailer", emailVerificationScope: "durable-object" } },
    { path: "/api/ready", status: 200, body: { status: "ready", emailVerification: "enforced", emailVerificationScope: "worker" } },
    { path: "/api/ready", status: 200, body: { status: "ready" } },
    { path: "/api/health", status: 503, body: { status: "ok" } },
    { path: "/api/health", status: 200, body: { status: "degraded" } },
    { path: "/api/ready", status: 503, body: { status: "ready" } },
    { path: "/api/ready", status: 200, body: { status: "not_ready" } },
    ...["/terms", "/privacy", "/"].map(path => ({ path, status: 503, body: "Unavailable" })),
  ];
  for (const failedDoor of ["origin", "entry"]) {
    for (const failure of failures) {
      test(`${mode}: rejects ${failedDoor} ${failure.path} (${failure.status}) while the other door is healthy`, async t => {
        const origin = await door(t, "/canonical", failedDoor === "origin" ? failure : null);
        const entry = await door(t, "/room", failedDoor === "entry" ? failure : null);
        const { code, report } = await runSmoke(origin, entry, withSha);
        assert.equal(code, 1, JSON.stringify(report));
        assert.equal(report.ok, false);
        const failed = report.checks.filter(check => !check.pass);
        assert.equal(failed.length, 1, JSON.stringify(report));
        const failedUrl = `${failedDoor === "origin" ? origin.url : entry.url}${failure.path}`;
        assert.ok(failed[0].name.includes(failedUrl), `failure identifies ${failedUrl}`);
        assert.equal(failed[0].status, failure.status);
      });
    }
  }
}

// This boundary is distinct from CLI exit behavior: Actions must preserve a
// failed command's exit through tee. Run the actual workflow commands under
// GitHub's documented Linux shell invocation, with both CLIs using local HTTP.
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsshell
for (const filename of ["prod-deploy-smoke.mjs", "live-smoke.mjs"]) {
  for (const healthy of filename === "prod-deploy-smoke.mjs" ? [false, true] : [false]) {
    test(`workflow pipeline ${filename}: preserves ${healthy ? "success" : "failure"} and tee output`, async t => {
      const workflow = parse(readFileSync(new URL("../.github/workflows/deploy-prod.yml", import.meta.url), "utf8"));
      const job = workflow.jobs.deploy;
      const step = job.steps.find(item => item.run?.includes(`node scripts/${filename}`));
      assert.ok(step, `deployment runs ${filename}`);
      const shell = step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell;
      assert.ok(shell === undefined || shell === "bash", "exercise the workflow's Linux Bash shell");
      const flags = shell === "bash" ? ["--noprofile", "--norc", "-e", "-o", "pipefail"] : ["-e"];
      const directory = mkdtempSync(join(tmpdir(), "prod-smoke-pipeline-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const stepFile = join(directory, "step.sh");
      writeFileSync(stepFile, step.run);
      const origin = await door(t, "");
      const entry = await door(t, "/room", healthy ? null : { path: "/api/ready", status: 503, body: { status: "not_ready" } });
      const result = await runReport("bash", [...flags, stepFile], {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: { ...process.env, SHA: revision, PROD_ORIGIN: origin.url, ENTRY_ORIGIN: entry.url,
          ROOM_SMOKE_ORIGIN: origin.url, ROOM_SMOKE_GITHUB_API: origin.url,
          RUNNER_TEMP: directory, GITHUB_TOKEN: "", GITHUB_STEP_SUMMARY: "", GITHUB_OUTPUT: join(directory, "step-output"),
          // The prod smoke step retries once after a delay; no wait in tests.
          SMOKE_RETRY_DELAY_SECONDS: "0",
          // The pipeline test runs the literal deploy-prod.yml step, so the
          // card-check test seams arrive through the env fallbacks.
          SMOKE_AGENT_CARD_PUBLIC_KEY: cardKeyPair.publicKey,
          SMOKE_AGENT_CARD_KEY_ID: cardKeyId,
          SMOKE_AGENT_CARD_AGENT_ID: cardAgentId,
          SMOKE_AGENT_CARD_FETCHES: "1" },
      });
      // The sparse fixture intentionally fails live-smoke's discovery checks.
      assert.equal(result.report.ok, healthy, result.stdout);
      const logs = readdirSync(directory).filter(name => name.endsWith(".json"));
      assert.equal(logs.length, 1, "tee retains one JSON report");
      assert.equal(readFileSync(join(directory, logs[0]), "utf8"), result.stdout);
      assert.equal(result.code, healthy ? 0 : 1, "the workflow must preserve the smoke exit status through tee");
      if (filename === "prod-deploy-smoke.mjs") {
        const first = JSON.parse(readFileSync(join(directory, "prod-smoke-attempt1.log"), "utf8"));
        assert.equal(first.ok, healthy);
        const digest = createHash("sha256").update(readFileSync(join(directory, "prod-smoke.json"))).digest("hex");
        assert.equal(readFileSync(join(directory, "step-output"), "utf8"), `report_sha256=${digest}\n`);
        if (!healthy) assert.equal(readdirSync(directory).includes("prod-smoke-attempt2.log"), false, "readiness failure is not retried");
        const upload = job.steps.find(item => item.with?.name === "deploy-recovery-${{ needs.gate.outputs.sha }}");
        assert.match(upload.with.path, /prod-smoke-attempt\*\.log/);
        assert.match(upload.with.path, /prod-smoke\.json/);
      }
    });
  }
}

for (const failedDoor of ["origin", "entry"]) {
  for (const path of versionPaths) {
    test(`with SHA: rejects a mismatched ${failedDoor} ${path}`, async t => {
      const failure = { path, status: 200, body: { sourceRevision: "b".repeat(40) } };
      const origin = await door(t, "/canonical", failedDoor === "origin" ? failure : null);
      const entry = await door(t, "/room", failedDoor === "entry" ? failure : null);
      const { code, report } = await runSmoke(origin, entry, true);
      assert.equal(code, 1, JSON.stringify(report));
      assert.equal(report.ok, false);
      const failed = report.checks.filter(check => !check.pass);
      assert.equal(failed.length, 1, JSON.stringify(report));
      assert.equal(failed[0].got, failure.body.sourceRevision);
      assert.ok(failed[0].name.includes(`${failedDoor === "origin" ? origin.url : entry.url}${path}`));
    });
  }
}


test("readiness diagnostics retain bounded timeout, error and ready evidence without response secrets", () => {
  for (const status of ["timeout", "error", "ok"]) {
    const detail = readinessDetail({status: status === "ok" ? 200 : 503, ms: 1234,
      json: {status: status === "ok" ? "ready" : "degraded", do: {status, ms: 1001, timeoutMs: 1000, statusCode: 200, error: "SECRET"}, secret: "SECRET"}});
    assert.deepEqual(detail.do, {status, ms: 1001, timeoutMs: 1000, statusCode: 200});
    assert.equal(detail.elapsedMs, 1234);
    assert.ok(!JSON.stringify(detail).includes("SECRET"));
  }
  const hostile = readinessDetail({status: 503, ms: Infinity, error: "SECRET", json: {
    status: "SECRET", emailVerification: "SECRET", emailVerificationScope: "SECRET",
    do: {status: "SECRET", ms: -1, timeoutMs: "1000", statusCode: 999}}});
  assert.deepEqual(hostile, {status: 503, body: null, emailVerification: "unknown", emailVerificationScope: "unknown", do: {status: "unknown"}});
  for (const errorKind of ["fetch_timeout", "fetch_error"]) assert.equal(readinessDetail({status: 0, errorKind, error: "SECRET"}).transport, errorKind);
});

test("real smoke CLI preserves failed readiness timeout evidence and still rejects it", async t => {
  const origin = await door(t, "/canonical");
  const entry = await door(t, "/room", {path: "/api/ready", status: 503, body: {
    status: "degraded", do: {status: "timeout", timeoutMs: 1000, ms: 1002, error: "SECRET"}}});
  const {code, report} = await runSmoke(origin, entry, false);
  assert.equal(code, 1);
  const failed = report.checks.find(check => !check.pass);
  assert.deepEqual(failed.do, {status: "timeout", ms: 1002, timeoutMs: 1000});
  assert.equal(typeof failed.elapsedMs, "number");
  assert.ok(!JSON.stringify(report).includes("SECRET"));
});


import { propagationRetry, pollConvergence } from "../scripts/prod-smoke-retry.mjs";
const retryOptions = { sha: revision, origin: "https://canonical.example", entry: "https://entry.example/room" };
const retryReport = () => ({ ok: false, ...retryOptions, checks: [retryOptions.origin, retryOptions.entry].flatMap(door => [
  ...versionPaths.map(path => ({ name: `version ${door}${path}`, pass: true, status: 200, got: revision })),
  ...smokePaths.map(path => ({ name: `${path === "/api/health" ? "health" : path === "/api/ready" ? "ready" : "page"} ${door}${path}`, pass: true })),
  { name: `agent-card ${door}${cardPath}`, pass: true },
]) });
test("retry requires complete report and exclusively verified stale evidence", () => {
  const report = retryReport();
  report.checks[0] = { ...report.checks[0], pass: false, got: "b".repeat(40) };
  assert.equal(propagationRetry(report, retryOptions), true);
  for (const mutation of [r => r.checks.pop(), r => r.checks.push(r.checks[0]), r => r.sha = "b".repeat(40),
    r => r.checks[0].status = 503, r => r.checks[0].got = "http 0", r => r.checks[3].pass = false,
    r => r.checks[7].pass = false, r => r.checks[1].pass = "true"]) {
    const invalid = structuredClone(report); mutation(invalid);
    assert.equal(propagationRetry(invalid, retryOptions), false);
  }
  report.checks[0].pass = true;
  report.checks[7] = { ...report.checks[7], pass: false, retryKind: "verified-stale-card" };
  assert.equal(propagationRetry(report, retryOptions), true);
  assert.equal(propagationRetry(null, retryOptions), false);
});
test("convergence polling progresses and stops at bounded budget or malformed evidence", async () => {
  let clock = 0, requests = 0; const progress = [];
  const options = { ...retryOptions, waitMs: 15000, now: () => clock,
    sleep: async ms => { clock += ms; }, progress: message => progress.push(message),
    fetchImpl: async () => ({ status: 200, json: async () => ({ sourceRevision: ++requests <= 4 ? "b".repeat(40) : revision }) }) };
  assert.equal(await pollConvergence(options), true);
  assert.equal(clock, 10000); assert.equal(requests, 8); assert.equal(progress.length, 2);
  clock = 0;
  assert.equal(await pollConvergence({ ...options, fetchImpl: async () => ({ status: 200, json: async () => ({ sourceRevision: "b".repeat(40) }) }) }), false);
  assert.equal(clock, 15000);
  clock = 0;
  assert.equal(await pollConvergence({ ...options, fetchImpl: async () => ({ status: 503, json: async () => ({ sourceRevision: revision }) }) }), false);
  assert.equal(clock, 0);
});

test("actual retry CLI refuses malformed reports and observes both local version doors", async t => {
  const directory = mkdtempSync(join(tmpdir(), "smoke-retry-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const origin = await door(t, ""), entry = await door(t, "/room");
  const path = join(directory, "report.json");
  const invoke = () => new Promise((resolve, reject) => execFile(process.execPath,
    [fileURLToPath(new URL("../scripts/prod-smoke-retry.mjs", import.meta.url)), path,
      "--sha", revision, "--origin", origin.url, "--entry", entry.url], { timeout: 5000 },
    (error, stdout, stderr) => error && typeof error.code !== "number" ? reject(error) : resolve({ code: error?.code ?? 0, stdout, stderr })));
  writeFileSync(path, "not JSON");
  assert.equal((await invoke()).code, 1);
  assert.equal(origin.requests.length + entry.requests.length, 0);
  const report = retryReport();
  report.origin = origin.url; report.entry = entry.url;
  for (const check of report.checks) check.name = check.name.replace(retryOptions.origin, origin.url).replace(retryOptions.entry, entry.url);
  report.checks[0] = { ...report.checks[0], pass: false, got: "b".repeat(40) };
  writeFileSync(path, JSON.stringify(report));
  const result = await invoke();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /target, target, target, target/);
  assert.equal(result.stdout, "");
  assert.deepEqual(origin.requests.toSorted(), versionPaths.toSorted());
  assert.deepEqual(entry.requests.toSorted(), versionPaths.map(path => `/room${path}`).toSorted());
});


test("target revision in an HTTP503 version response cannot pass smoke or propagation retry", async t => {
  const origin = await door(t, "/canonical", { path: "/api/version", status: 503, body: { sourceRevision: revision } });
  const entry = await door(t, "/room");
  const result = await runSmoke(origin, entry, true);
  assert.equal(result.code, 1);
  const failure = result.report.checks.find(check => check.name === `version ${origin.url}/api/version`);
  assert.equal(failure.pass, false);
  assert.equal(failure.status, 503);
  assert.equal(failure.got, revision);
  assert.equal(propagationRetry(result.report, { sha: revision, origin: origin.url, entry: entry.url }), false);
});
