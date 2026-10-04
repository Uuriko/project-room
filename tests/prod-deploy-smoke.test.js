import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/prod-deploy-smoke.mjs", import.meta.url));
const revision = "a".repeat(40);
const smokePaths = ["/api/health", "/api/ready", "/terms", "/privacy", "/"];
const versionPaths = ["/api/version", "/api/version/worker"];

// Exercise the shipped CLI over real HTTP. Unknown paths/methods fail closed,
// so dropping either door's path prefix cannot accidentally pass the fixture.
async function door(t, prefix, failure) {
  const requests = [];
  const responses = new Map([
    ["/api/health", { status: "ok" }],
    ["/api/ready", { status: "ready" }],
    ...versionPaths.map(path => [path, { sourceRevision: revision }]),
    ...["/terms", "/privacy", "/"].map(path => [path, "<!doctype html><title>Room</title>"]),
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

async function runSmoke(origin, entry, withSha) {
  const args = [script, "--origin", `${origin.url}/`, "--entry", `${entry.url}/`];
  if (withSha) args.push("--sha", revision, "--wait-ms", "0");
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      try {
        resolve({ code: error?.code ?? 0, report: JSON.parse(stdout), stderr });
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
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
    const paths = [...smokePaths, ...(withSha ? versionPaths : [])];
    for (const current of [origin, entry]) {
      assert.deepEqual(current.requests.toSorted(), paths.map(path => `${current.prefix}${path}`).toSorted());
    }
    assert.equal(report.checks.length, paths.length * 2);
    assert.ok(report.checks.every(check => check.pass));
  });

  const failures = [
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
