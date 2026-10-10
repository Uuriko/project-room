// Fail-first tests for scripts/smoke-prod.mjs (audit lane C4, 2026-10-07).
// The Zero-Bug phase-2 smoke had two deploy-health gaps: it never asserted
// WHAT build prod serves (a stale/unstamped deploy passes all three probes),
// and nothing in it distinguished "worker alive" from "Durable Object awake"
// (/api/health never enters the DO). These tests pin the two new probes:
//   D. deployed-revision — GET /api/version/worker must be a stamped,
//      worker-served 40-hex revision (optionally pinned with --expect-sha)
//   E. do-readiness — GET /api/ready must be 200 + status "ready"
// plus Server-Timing stall reporting on the DO-backed claims-board probe.
// Exercised over real HTTP against stub servers via the shipped CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/smoke-prod.mjs", import.meta.url));
const REV = "8a4b3a6af4fbd9e633e6b27b17c7b342fefec5b7";
const OTHER_REV = "a".repeat(40);

async function withServer(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const json = (res, status = 200, extraHeaders = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(res.body));
};

// A fully healthy prod double: landing HTML, claims-board JSON with
// Server-Timing, priced-tool 401 refusal, stamped worker version, ready DO.
function healthy(t, overrides = {}) {
  return withServer(t, (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html><body>room</body></html>");
    }
    if (url.pathname === "/api/opportunities.json") {
      res.body = { opportunities: [] };
      return json(res, 200, { "server-timing": "app;dur=3, total;dur=40" });
    }
    if (url.pathname === "/mcp" && req.method === "POST") {
      res.body = { jsonrpc: "2.0", id: "zero-bug-smoke", error: { code: -32001, data: { reason: "auth_required" } } };
      return json(res, 401);
    }
    if (url.pathname === "/api/version/worker") {
      res.body = { status: "ok", servedBy: "worker", sourceRevision: REV, buildId: "2026-10-07T14:03:08.010Z", deployment: "production" };
      return json(res);
    }
    if (url.pathname === "/api/ready") {
      res.body = { status: "ready", mode: "cloudflare-production", do: { status: "ok", statusCode: 200, ms: 25 } };
      return json(res);
    }
    if (overrides.onUnknown) return overrides.onUnknown(req, res);
    res.writeHead(404);
    res.end("nope");
  });
}

async function runSmoke(base, extraArgs = []) {
  try {
    const { stdout } = await run(process.execPath, [script, "--json", "--base", base, "--room", "muse-room", ...extraArgs]);
    return { code: 0, report: JSON.parse(stdout) };
  } catch (error) {
    assert.equal(error.code, 1, `expected exit 1, got ${error.code}: ${error.stdout}`);
    return { code: 1, report: JSON.parse(error.stdout) };
  }
}

const resultByName = (report, name) => report.results.find(r => r.name === name);

test("all five probes pass against a healthy prod double", async t => {
  const base = await healthy(t);
  const { code, report } = await runSmoke(base);
  assert.equal(code, 0);
  assert.equal(report.allPass, true);
  assert.deepEqual(report.results.map(r => r.name),
    ["landing-page", "claims-board-read", "priced-tool-refusal", "deployed-revision", "do-readiness"]);
  assert.match(resultByName(report, "deployed-revision").detail, new RegExp(REV));
  assert.match(resultByName(report, "do-readiness").detail, /do\.ms=25ms/);
});

test("deployed-revision fails on an unstamped build", async t => {
  const base = await withServer(t, (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/version/worker") {
      res.body = { status: "ok", servedBy: "worker", sourceRevision: "unstamped", buildId: "unstamped" };
      return json(res);
    }
    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html></html>"); }
    if (url.pathname === "/api/opportunities.json") { res.body = { opportunities: [] }; return json(res); }
    if (url.pathname === "/mcp") {
      res.body = { jsonrpc: "2.0", id: "x", error: { code: -32001, data: { reason: "auth_required" } } };
      return json(res, 401);
    }
    if (url.pathname === "/api/ready") { res.body = { status: "ready", do: { status: "ok", ms: 9 } }; return json(res); }
    res.writeHead(404); res.end();
  });
  const { code, report } = await runSmoke(base);
  assert.equal(code, 1);
  assert.equal(report.allPass, false);
  const rev = resultByName(report, "deployed-revision");
  assert.equal(rev.pass, false);
  assert.match(rev.detail, /not stamped/);
});

test("deployed-revision fails when the route is not worker-served", async t => {
  // A double where /api/version/worker is answered by the DO path
  // (servedBy missing): the pin must not silently pass.
  const base2 = await withServer(t, (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/version/worker") {
      res.body = { status: "ok", sourceRevision: REV };
      return json(res);
    }
    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html></html>"); }
    if (url.pathname === "/api/opportunities.json") { res.body = { opportunities: [] }; return json(res); }
    if (url.pathname === "/mcp") {
      res.body = { jsonrpc: "2.0", id: "x", error: { code: -32001, data: { reason: "auth_required" } } };
      return json(res, 401);
    }
    if (url.pathname === "/api/ready") { res.body = { status: "ready", do: { status: "ok", ms: 9 } }; return json(res); }
    res.writeHead(404); res.end();
  });
  const { code, report } = await runSmoke(base2);
  assert.equal(code, 1);
  assert.equal(resultByName(report, "deployed-revision").pass, false);
});

test("--expect-sha pins the deployed commit", async t => {
  const base = await healthy(t);
  const ok = await runSmoke(base, ["--expect-sha", REV]);
  assert.equal(ok.code, 0);
  assert.equal(resultByName(ok.report, "deployed-revision").pass, true);
  const bad = await runSmoke(base, ["--expect-sha", OTHER_REV]);
  assert.equal(bad.code, 1);
  assert.equal(resultByName(bad.report, "deployed-revision").pass, false);
  assert.match(resultByName(bad.report, "deployed-revision").detail, /does not match/);
});

test("do-readiness fails on 503 degraded while the DO warms", async t => {
  const base = await withServer(t, (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html></html>"); }
    if (url.pathname === "/api/opportunities.json") { res.body = { opportunities: [] }; return json(res); }
    if (url.pathname === "/mcp") {
      res.body = { jsonrpc: "2.0", id: "x", error: { code: -32001, data: { reason: "auth_required" } } };
      return json(res, 401);
    }
    if (url.pathname === "/api/version/worker") {
      res.body = { status: "ok", servedBy: "worker", sourceRevision: REV };
      return json(res);
    }
    if (url.pathname === "/api/ready") {
      // What prod returns while the DO constructor still holds the input gate.
      res.body = { status: "degraded", do: { status: "timeout", timeoutMs: 1000, ms: 1000 } };
      return json(res, 503);
    }
    res.writeHead(404); res.end();
  });
  const { code, report } = await runSmoke(base);
  assert.equal(code, 1);
  const ready = resultByName(report, "do-readiness");
  assert.equal(ready.pass, false);
  assert.match(ready.detail, /503/);
});

test("do-readiness fails when the body is not ready", async t => {
  const base = await withServer(t, (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html></html>"); }
    if (url.pathname === "/api/opportunities.json") { res.body = { opportunities: [] }; return json(res); }
    if (url.pathname === "/mcp") {
      res.body = { jsonrpc: "2.0", id: "x", error: { code: -32001, data: { reason: "auth_required" } } };
      return json(res, 401);
    }
    if (url.pathname === "/api/version/worker") {
      res.body = { status: "ok", servedBy: "worker", sourceRevision: REV };
      return json(res);
    }
    if (url.pathname === "/api/ready") { res.body = { status: "ok", do: { status: "ok" } }; return json(res); }
    res.writeHead(404); res.end();
  });
  const { code, report } = await runSmoke(base);
  assert.equal(code, 1);
  assert.equal(resultByName(report, "do-readiness").pass, false);
});

test("claims-board probe reports the Server-Timing stall (total - app)", async t => {
  const base = await healthy(t);
  const { code, report } = await runSmoke(base);
  assert.equal(code, 0);
  const detail = resultByName(report, "claims-board-read").detail;
  assert.match(detail, /app=3ms/);
  assert.match(detail, /total=40ms/);
  assert.match(detail, /stall=37ms/);
});

test("priced-tool refusal contract is unchanged (401 auth_required, never 500)", async t => {
  const base = await withServer(t, (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html></html>"); }
    if (url.pathname === "/api/opportunities.json") { res.body = { opportunities: [] }; return json(res); }
    if (url.pathname === "/mcp") { res.writeHead(500); return res.end("boom"); }
    if (url.pathname === "/api/version/worker") {
      res.body = { status: "ok", servedBy: "worker", sourceRevision: REV };
      return json(res);
    }
    if (url.pathname === "/api/ready") { res.body = { status: "ready", do: { status: "ok", ms: 9 } }; return json(res); }
    res.writeHead(404); res.end();
  });
  const { code, report } = await runSmoke(base);
  assert.equal(code, 1);
  const probe = resultByName(report, "priced-tool-refusal");
  assert.equal(probe.pass, false);
  assert.match(probe.detail, /500/);
});
