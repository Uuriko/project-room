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
