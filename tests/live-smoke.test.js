// Contract for scripts/live-smoke.mjs, run as the CLI the scheduled workflow
// runs, against a local stand-in for the live origin and the GitHub API.
// Protects: (1) a discovery document that advertises a missing same-host
// route fails the run, while POST-only/auth routes (405/401) and templated
// URLs do not; (2) a deploy that lags main past the threshold fails the run,
// a fresh one only warns; (3) a healthy origin passes with no failures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PUBLIC_PAGES, browserSmoke } from "../scripts/live-smoke.mjs";

const run = promisify(execFile);
const LIVE = "a".repeat(40);
const MAIN = "b".repeat(40);
const HOUR = 36e5;

function stand(overrides = {}) {
  const routes = {
    "/api/version": [200, "application/json", JSON.stringify({ sourceRevision: LIVE })],
    "/llms.txt": [200, "text/plain", "# Room"],
    "/llms-full.txt": [200, "text/plain", "# Room"],
    "/.well-known/agent-card.json": [200, "application/json", null],
    "/.well-known/agent.json": [200, "application/json", "{}"],
    "/.well-known/ai-catalog.json": [200, "application/json", "{}"],
    "/.well-known/mcp.json": [200, "application/json", "{}"],
    "/mcp/server-card": [200, "application/json", "{}"],
    "/agents.json": [200, "application/json", "{}"],
    "/openapi.json": [200, "application/json", "{}"],
    "/robots.txt": [200, "text/plain", "User-agent: *\nAllow: /\n"],
    "/sitemap.xml": [200, "application/xml", "<urlset><url><loc>https://room.trydemigod.com/receipts/pwr_abcdabcdabcdabcd</loc></url></urlset>"],
    "/favicon.ico": [200, "image/x-icon", "x"],
    "/a2a": [405, "application/json", "{}"],
    "/api/needs-me": [401, "application/json", "{}"],
    "/repos/Uuriko/project-room/commits/main": [200, "application/json", JSON.stringify({ sha: LIVE })],
    ...overrides,
  };
  for (const page of [...PUBLIC_PAGES, "/receipts/pwr_abcdabcdabcdabcd"]) routes[page] ??= [200, "text/html", "<!doctype html><title>Room</title>"];
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const origin = `http://127.0.0.1:${server.address().port}`;
    const [status, type, body] = routes[path] ?? [404, "text/html", "<!doctype html><title>Not found</title>"];
    res.writeHead(status, { "content-type": type });
    res.end(body ?? JSON.stringify({ url: `${origin}/a2a`, endpoints: [`${origin}/api/needs-me`, `${origin}/api/rooms/{roomId}/events`] }));
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function smoke(server) {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, ROOM_SMOKE_ORIGIN: origin, ROOM_SMOKE_GITHUB_API: origin, GITHUB_TOKEN: "", GITHUB_STEP_SUMMARY: "" };
  try {
    const { stdout } = await run(process.execPath, ["scripts/live-smoke.mjs"], { env });
    return { code: 0, report: JSON.parse(stdout) };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, report: JSON.parse(error.stdout) };
  } finally { server.close(); }
}

const failures = report => report.findings.filter(f => f.severity === "fail").map(f => f.code);

test("a healthy origin passes: 405/401 routes and templated URLs are not broken links", async () => {
  const { code, report } = await smoke(await stand());
  assert.deepEqual(failures(report), []);
  assert.equal(report.deploy.status, "current");
  assert.equal(code, 0);
});

test("an advertised same-host route that 404s fails the run", async () => {
  const { code, report } = await smoke(await stand({ "/a2a": [404, "application/json", "{}"] }));
  assert.equal(code, 1);
  assert.deepEqual(report.findings.filter(f => f.severity === "fail").map(f => [f.code, f.detail.endsWith("/a2a -> 404")]), [["advertised_url", true]]);
});

test("deploy lag: past the threshold fails, a fresh merge only warns", async () => {
  const compare = ageHours => [200, "application/json", JSON.stringify({ status: "ahead", ahead_by: 2, behind_by: 0,
    commits: [{ commit: { committer: { date: new Date(Date.now() - ageHours * HOUR).toISOString() } } }] })];
  const main = [200, "application/json", JSON.stringify({ sha: MAIN })];
  const comparePath = `/repos/Uuriko/project-room/compare/${LIVE}...${MAIN}`;

  const stale = await smoke(await stand({ "/repos/Uuriko/project-room/commits/main": main, [comparePath]: compare(30) }));
  assert.equal(stale.code, 1);
  assert.deepEqual(failures(stale.report), ["deploy_lag"]);

  const fresh = await smoke(await stand({ "/repos/Uuriko/project-room/commits/main": main, [comparePath]: compare(1) }));
  assert.equal(fresh.code, 0);
  assert.equal(fresh.report.deploy.status, "pending");
});

// A smoke classification regression must not hide CSP breakage on repaired
// pages behind historical warnings. Transport/browser enforcement lives in
// the public-page browser journey; this isolates the reporting boundary.
test("public-page CSP regressions remain hard failures after the analytics repair", async () => {
  const browser = {
    async newContext() { return {
      async newPage() { let onConsole; return {
        on(type, callback) { if (type === "console") onConsole = callback; },
        async goto() { onConsole({ type: () => "error", text: () => "Connecting violates Content Security Policy connect-src" }); },
        async waitForTimeout() {}, async evaluate() { return 0; }
      }; }, async close() {}
    }; }, async close() {}
  };
  const paths = ["/about", "/receipts", ...PUBLIC_PAGES.filter(path => path.startsWith("/compare/"))];
  const report = await browserSmoke({ browserFactory: async () => browser, pages: paths, viewports: [390] });
  assert.equal(report.ok, false);
  assert.deepEqual(report.findings.filter(f => f.code === "csp_console").map(f => [f.detail.split("@")[0], f.severity, f.known]),
    paths.map(path => [path, "fail", undefined]));
});
