import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const revision = "a".repeat(40);

async function withServer(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function versionBody(res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "ok", sourceRevision: revision }));
}

test("cold-start probe accepts one fast version response and rejects a slow one", async t => {
  let delay = 0;
  const base = await withServer(t, (_req, res) => {
    setTimeout(() => versionBody(res), delay);
  });
  const fast = await run(process.execPath, ["scripts/cold-start-probe.mjs", "--base", base, "--max-ms", "2000"]);
  const fastReport = JSON.parse(fast.stdout);
  assert.equal(fastReport.pass, true);
  assert.equal(fastReport.sourceRevision, revision);
  assert.ok(fastReport.elapsedMs < 2000);
  delay = 80;
  await assert.rejects(run(process.execPath, ["scripts/cold-start-probe.mjs", "--base", base, "--max-ms", "40"]), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).pass, false);
    return true;
  });
});

test("cold-start probe rejects a version body that is not a deployed revision", async t => {
  const base = await withServer(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  await assert.rejects(run(process.execPath, ["scripts/cold-start-probe.mjs", "--base", base, "--max-ms", "2000"]), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).sourceRevision, null);
    return true;
  });
});

test("cold-start probe gates on the worker route and reports the DO route separately", async t => {
  const seenPaths = [];
  const base = await withServer(t, (req, res) => {
    seenPaths.push(req.url);
    // The DO route is deliberately far slower than the gate budget: its
    // elapsed time must be reported, not folded into the gated result.
    // Margins are wide on purpose: this test runs under parallel load on
    // shared machines, so it asserts the split, not scheduler precision.
    if (req.url === "/api/version") return setTimeout(() => versionBody(res), 600);
    return versionBody(res);
  });
  const { stdout } = await run(process.execPath, ["scripts/cold-start-probe.mjs", "--base", base, "--max-ms", "250"]);
  const report = JSON.parse(stdout);
  assert.equal(report.pass, true, "a slow DO cold start must not fail the worker gate");
  assert.equal(report.url, `${base}/api/version/worker`);
  assert.equal(report.workerCold.gated, true);
  assert.equal(report.workerCold.budgetMs, 250);
  assert.ok(report.workerCold.elapsedMs < 250);
  assert.equal(report.doCold.url, `${base}/api/version`);
  assert.equal(report.doCold.gated, false);
  assert.equal(report.doCold.budgetMs, null);
  assert.equal(report.doCold.answered, true);
  assert.ok(report.doCold.elapsedMs >= 500, `DO measurement keeps its own elapsed time, got ${report.doCold.elapsedMs}`);
  assert.deepEqual(seenPaths, ["/api/version/worker", "/api/version"], "worker probe runs first, DO probe is the first DO-touching request");
  assert.deepEqual(report.incidentSignals, { error1101WorkerJsException: 0, error1102WorkerCpuLimitExceeded: 0 });
});

test("cold-start probe counts 1101 and 1102 as separate incident signals", async t => {
  const base = await withServer(t, (req, res) => {
    if (req.url === "/api/version") {
      res.writeHead(500, { "content-type": "text/html" });
      return res.end("<title>Error 1101</title> Worker threw an exception");
    }
    return versionBody(res);
  });
  // A DO-side 1101 is reported in the DO measurement and the totals, split
  // from 1102, and does not turn the worker gate red.
  const { stdout } = await run(process.execPath, ["scripts/cold-start-probe.mjs", "--base", base, "--max-ms", "2000"]);
  const report = JSON.parse(stdout);
  assert.equal(report.pass, true);
  assert.equal(report.doCold.status, 500);
  assert.deepEqual(report.doCold.incidentSignals, { error1101WorkerJsException: 1, error1102WorkerCpuLimitExceeded: 0 });
  assert.deepEqual(report.workerCold.incidentSignals, { error1101WorkerJsException: 0, error1102WorkerCpuLimitExceeded: 0 });
  assert.deepEqual(report.incidentSignals, { error1101WorkerJsException: 1, error1102WorkerCpuLimitExceeded: 0 });
});

test("cold-start probe reports a worker-side 1102 under its own signal, not as 1101", async t => {
  const base = await withServer(t, (_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("error code: 1102");
  });
  await assert.rejects(run(process.execPath, ["scripts/cold-start-probe.mjs", "--base", base, "--max-ms", "2000"]), error => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.equal(report.pass, false);
    assert.deepEqual(report.workerCold.incidentSignals, { error1101WorkerJsException: 0, error1102WorkerCpuLimitExceeded: 1 });
    // Both requests hit the same 1102 page here, so the total counts each
    // response once — still under 1102 only, never merged into 1101.
    assert.deepEqual(report.incidentSignals, { error1101WorkerJsException: 0, error1102WorkerCpuLimitExceeded: 2 });
    return true;
  });
});
