// TST-13: the read-only public-route probe derives its matrix from openapi.yaml,
// sends only credential-free GETs, and fails only on 5xx or network errors.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { publicGetRoutes, probePublicRoutes, summaryLine, SCHEMA } from "../scripts/probe-public-routes.mjs";

const run = promisify(execFile);

async function withServer(t, handler) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, cookie: req.headers.cookie });
    const status = handler(req.url);
    res.writeHead(status, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

test("matrix comes from openapi public GETs and skips ids, auth flows and MCP", () => {
  const { probe, skipped } = publicGetRoutes();
  assert.ok(probe.length >= 10, `expected a real public matrix, got ${probe.length}`);
  for (const path of ["/api/health", "/api/version", "/api/health/jobs", "/api/ready"]) assert.ok(probe.includes(path), path);
  assert.ok(probe.every(path => !path.includes("{")), "no path-parameter route is probed");
  assert.ok(probe.every(path => !path.startsWith("/api/auth/") && path !== "/mcp" && path !== "/room/mcp"));
  assert.ok(skipped.some(s => s.reason === "path-parameter"));
  assert.ok(skipped.some(s => s.path === "/mcp" && s.reason === "auth-or-stream"));
  assert.ok(!probe.some(path => path.startsWith("/api/rooms/")), "room routes need a credential and are never public");
});

test("private operations and non-GET operations are excluded", () => {
  const spec = { security: [{ bearerAuth: [] }], paths: {
    "/open": { get: { security: [] } },
    "/optional": { get: { security: [{}, { bearerAuth: [] }] } },
    "/private": { get: {} },
    "/write": { post: { security: [] } },
  } };
  assert.deepEqual(publicGetRoutes(spec).probe, ["/open", "/optional"]);
});

test("probe sends credential-free GETs only and passes on any status below 500", async t => {
  const { base, seen } = await withServer(t, url => (url === "/a" ? 200 : url === "/b" ? 401 : 404));
  const report = await probePublicRoutes(base, { routes: { probe: ["/a", "/b", "/c"], skipped: [] }, delayMs: 0 });
  assert.equal(report.schema, SCHEMA);
  assert.equal(report.verdict, "answering");
  assert.equal(report.failed, 0);
  assert.deepEqual(report.statusClasses, { "2xx": 1, "4xx": 2 });
  assert.ok(seen.every(r => r.method === "GET" && !r.auth && !r.cookie));
  assert.match(summaryLine(report), /^public-probe answering .* probed=3 failed=0 skipped=0/);
});

test("5xx and network errors fail the run and are named in the summary", async t => {
  const { base } = await withServer(t, url => (url === "/bad" ? 503 : 200));
  const report = await probePublicRoutes(base, { routes: { probe: ["/ok", "/bad"], skipped: [{ path: "/x/{id}", reason: "path-parameter" }] }, delayMs: 0 });
  assert.equal(report.verdict, "failing");
  assert.equal(report.failed, 1);
  assert.match(summaryLine(report), /FAIL \/bad:503/);
  const dead = await probePublicRoutes("http://127.0.0.1:9", { routes: { probe: ["/x"], skipped: [] }, delayMs: 0, timeoutMs: 2000 });
  assert.equal(dead.results[0].status, 0);
  assert.equal(dead.verdict, "failing");
});

test("CLI exits 0 when everything answers, 1 on failure, 2 on bad usage", async t => {
  const { base } = await withServer(t, () => 200);
  const ok = await run(process.execPath, ["scripts/probe-public-routes.mjs", "--base", base, "--delay-ms", "0", "--json"]);
  const report = JSON.parse(ok.stdout);
  assert.equal(report.verdict, "answering");
  assert.equal(report.probed, publicGetRoutes().probe.length);
  const { base: failing } = await withServer(t, () => 500);
  await assert.rejects(run(process.execPath, ["scripts/probe-public-routes.mjs", "--base", failing, "--delay-ms", "0"]), e => e.code === 1 && /public-probe failing/.test(e.stdout));
  await assert.rejects(run(process.execPath, ["scripts/probe-public-routes.mjs", "--base", "not-a-url"]), e => e.code === 2);
});
