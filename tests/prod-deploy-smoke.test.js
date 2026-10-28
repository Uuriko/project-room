import test from "node:test";
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
const fixtureBuildId = "2026-10-27T00:00:00.000Z-run-4242-1";
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
    ...versionPaths.map(path => [path, { sourceRevision: revision, buildId: fixtureBuildId }]),
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

function runSmoke(origin, entry, withSha, buildId) {
  const args = [script, "--origin", `${origin.url}/`, "--entry", `${entry.url}/`,
    "--agent-card-public-key", cardKeyPair.publicKey,
    "--agent-card-key-id", cardKeyId,
    "--agent-card-agent-id", cardAgentId,
    // One fetch per door: the production default (10 fetches x 1.5s gaps x 2
    // doors ~ 27s) cannot fit inside the CLI timeout this suite enforces.
    "--agent-card-fetches", "1"];
  if (withSha) args.push("--sha", revision, "--wait-ms", "0");
  if (buildId) args.push("--build-id", buildId);
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
          RUNNER_TEMP: directory, GITHUB_TOKEN: "", GITHUB_STEP_SUMMARY: "",
          // The literal deploy step reads the run's build identity from
          // BUILD_ID (in the workflow it is the stamp step's output).
          BUILD_ID: fixtureBuildId,
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
        // One smoke attempt, one report file: no attempt1/attempt2 retry pair.
        const only = JSON.parse(readFileSync(join(directory, "prod-smoke.json"), "utf8"));
        assert.deepEqual(only, result.report);
        assert.equal(readdirSync(directory).filter(name => name.includes("attempt")).length, 0);
        const upload = job.steps.find(item => item.with?.name === "deploy-recovery-${{ needs.gate.outputs.sha }}");
        assert.doesNotMatch(upload.with.path, /attempt/);
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


// The deploy run stamps ONE build identity into both Workers; the smoke
// must prove it verified that run's build, not an earlier deploy of the
// same revision (a redeploy, or a concurrent run's publish, reports the
// same sourceRevision with a different buildId).
test("with SHA and build id: passes when both doors report this run's build", async t => {
  const origin = await door(t, "/canonical");
  const entry = await door(t, "/room");
  const { code, report } = await runSmoke(origin, entry, true, fixtureBuildId);
  assert.equal(code, 0, JSON.stringify(report));
  const versionChecks = report.checks.filter(check => check.name.startsWith("version "));
  assert.equal(versionChecks.length, 4);
  assert.ok(versionChecks.every(check => check.pass && check.gotBuildId === fixtureBuildId));
});

test("with SHA and build id: rejects doors still serving a previous build of the same revision", async t => {
  const origin = await door(t, "/canonical");
  const entry = await door(t, "/room");
  const { code, report } = await runSmoke(origin, entry, true, "1999-01-01T00:00:00.000Z-run-1-1");
  assert.equal(code, 1, JSON.stringify(report));
  assert.equal(report.ok, false);
  const failed = report.checks.filter(check => !check.pass);
  assert.equal(failed.length, 4, JSON.stringify(report));
  assert.ok(failed.every(check => check.name.startsWith("version ") && check.gotBuildId === fixtureBuildId && check.got === revision));
});

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
