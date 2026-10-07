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

test("cold-start probe accepts one fast version response and rejects a slow one", async t => {
  let delay = 0;
  const base = await withServer(t, (_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", sourceRevision: revision }));
    }, delay);
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

// The 2026-10-07 ea9bdf20 staging run failed at 3031 ms wall clock with no
// way to tell our cold start from the edge loading a script deployed 100 ms
// earlier. The Worker's own Server-Timing total separates the two.
function timed(t, { delay = 0, timing }) {
  return withServer(t, (_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json", ...(timing ? { "server-timing": timing } : {}) });
      res.end(JSON.stringify({ status: "ok", sourceRevision: revision }));
    }, delay);
  });
}
const probe = (base, ...extra) => run(process.execPath, ["scripts/cold-start-probe.mjs", "--base", base, ...extra]);
const failure = error => { assert.equal(error.code, 1); return JSON.parse(error.stdout); };

test("cold-start probe judges the Worker total, not network and edge time", async t => {
  const base = await timed(t, { delay: 150, timing: "app;dur=4, total;dur=12" });
  const report = JSON.parse((await probe(base, "--max-ms", "100", "--max-wall-ms", "5000")).stdout);
  assert.equal(report.pass, true);
  assert.equal(report.judgedOn, "Worker total");
  assert.equal(report.serverMs, 12);
  assert.equal(report.appMs, 4);
  assert.ok(report.elapsedMs >= 150);
  assert.equal(report.networkAndEdgeMs, report.elapsedMs - 12);
});

test("cold-start probe fails a slow Worker total even when the wall clock is fast", async t => {
  const base = await timed(t, { timing: "app;dur=40, total;dur=2500" });
  const report = await probe(base, "--max-ms", "2000").then(() => assert.fail("must fail"), failure);
  assert.equal(report.pass, false);
  assert.deepEqual(report.reasons, ["Worker total 2500 ms, budget 2000 ms"]);
});

test("cold-start probe still fails past the wall-clock ceiling", async t => {
  const base = await timed(t, { delay: 300, timing: "total;dur=5" });
  const report = await probe(base, "--max-ms", "100", "--max-wall-ms", "200").then(() => assert.fail("must fail"), failure);
  assert.equal(report.pass, false);
  assert.match(report.reasons.join(" "), /wall clock, ceiling 200 ms/);
});

test("cold-start probe without Worker timing keeps the wall-clock budget", async t => {
  const base = await timed(t, { delay: 150 });
  const report = await probe(base, "--max-ms", "100", "--max-wall-ms", "5000").then(() => assert.fail("must fail"), failure);
  assert.equal(report.judgedOn, "wall clock (no Worker timing)");
  assert.equal(report.serverMs, null);
  assert.match(report.reasons[0], /no Worker timing, budget 100 ms/);
});

test("cold-start probe refuses a wall ceiling below the budget", async () => {
  await assert.rejects(probe("http://127.0.0.1:9", "--max-ms", "2000", "--max-wall-ms", "1000"), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /must be at least --max-ms/);
    return true;
  });
});
