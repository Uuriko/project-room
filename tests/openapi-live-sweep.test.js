// Lane F1 (40-lane audit 2026-10-07): OpenAPI live-sweep tests.
//
// scripts/openapi-live-sweep.mjs is the mechanical spec-vs-live drift check:
// every operation in docs/openapi.yaml is probed against an origin, and every
// /api path in the served /openapi.json must be documented. These tests pin
// the sweep's contract:
//
//  1. Probe safety: open (security: []) mutating operations are NEVER sent
//     their documented method on a live origin (alternate-method existence
//     probe only); documented methods are sent only with allowWriteMethods
//     (scratch servers) or for non-mutating / authenticated operations.
//  2. Verdicts: method_mismatch / not_served / exists_unverified /
//     needs_review classify correctly against a controlled stub origin.
//  3. Direction 2: a live-served /api path missing from the spec is reported.
//  4. Fail-first regression: the full sweep against a scratch server built
//     from this working tree reports zero hard drift — if docs/openapi.yaml
//     ever documents an unserved operation (or a served /api path goes
//     undocumented), this test fails naming it.
//
// Authoring-gate answers (.agents/skills/test-audit/SKILL.md):
// 1. Protects the spec-vs-deployed contract the audit verified by hand on
//    2026-10-07 (513/513 operations live-verified on prod, 45/45 live /api
//    paths documented): without this test the next undocumented route or
//    method change ships silently.
// 2. Credible regression: delete the POST /api/join entry from
//    docs/openapi.yaml's paths... (direction 1 needs a live origin; the
//    scratch sweep catches the reverse) — concretely: remove the
//    /api/version GET entry from the spec and the scratch sweep still passes
//    (it only checks spec->server), but add a bogus POST /api/definitely-
//    not-a-route entry and the sweep fails naming it; drop a served route
//    from server/http.mjs's route table and tests/route-docs-check.test.js
//    (the companion gate) fails. Direction-2 unit tests below fail on a
//    fabricated undocumented live path.
// 3. Existing coverage: tests/openapi-method-accuracy.test.js pins
//    spec->scratch-server method accuracy; tests/route-docs-check.test.js
//    pins route-template inventory; tests/openapi-served-coverage.test.js
//    pins the served /openapi.json inventory. None probes a LIVE origin with
//    the open-write safety rule, and none asserts the sweep's verdict
//    taxonomy — that is what this file owns.
// 4. No production seam: imports the sweep's exported pure functions and
//    boots scratch servers (disposable temp dirs, like the existing gates).
//    The live origin is never touched by tests.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  alternateMethod,
  isOpenWrite,
  classifyLive,
  sweepLive,
  undocumentedLivePaths,
  renderSummary,
} from "../scripts/openapi-live-sweep.mjs";
import { serveScratch } from "../scripts/openapi-method-accuracy.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const openapiText = readFileSync(join(ROOT, "docs/openapi.yaml"), "utf8");

// ---------------------------------------------------------------------------
// Verdict taxonomy (pure logic, no network)
// ---------------------------------------------------------------------------

test("alternateMethod never returns the documented method", () => {
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    assert.notEqual(alternateMethod(m), m);
  }
});

test("isOpenWrite: open mutating ops are write-risky, everything else is not", () => {
  assert.equal(isOpenWrite({ method: "POST", security: [] }), true);
  assert.equal(isOpenWrite({ method: "DELETE", security: [] }), true);
  assert.equal(isOpenWrite({ method: "PUT", security: [] }), true);
  assert.equal(isOpenWrite({ method: "PATCH", security: [] }), true);
  assert.equal(isOpenWrite({ method: "GET", security: [] }), false);
  assert.equal(isOpenWrite({ method: "HEAD", security: [] }), false);
  assert.equal(isOpenWrite({ method: "POST", security: null }), false); // inherits default: authenticated
  assert.equal(isOpenWrite({ method: "POST", security: ["agentKey"] }), false);
});

// ---------------------------------------------------------------------------
// classifyLive against a stub origin
// ---------------------------------------------------------------------------

// classifyLive fetches over HTTP; exercise it against a real local HTTP
// server instead of stubbing fetch, so the probe path (status/code reading,
// body cancellation) is genuinely covered.
import http from "node:http";

async function withStubServer(t, routes, fn) {
  const server = http.createServer((req, res) => {
    const hit = routes[`${req.method} ${req.url}`];
    if (hit) {
      res.writeHead(hit.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(hit.body ?? {}));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found" } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return fn(`http://127.0.0.1:${server.address().port}`);
}

const op = (method, path, security = null) => ({ method, path, security, parameterLines: [] });

test("classifyLive: served route with documented method is ok", async (t) => {
  await withStubServer(t, { "GET /api/version": { status: 200 } }, async (origin) => {
    const r = await classifyLive(origin, op("GET", "/api/version"));
    assert.equal(r.verdict, "ok");
  });
});

test("classifyLive: authenticated route answering 401 is ok (route exists)", async (t) => {
  await withStubServer(t, { "GET /api/rooms/x/work-claims": { status: 401 } }, async (origin) => {
    const r = await classifyLive(origin, op("GET", "/api/rooms/x/work-claims"));
    assert.equal(r.verdict, "ok");
  });
});

test("classifyLive: 405 on the documented method is a method mismatch", async (t) => {
  await withStubServer(t, { "POST /api/thing": { status: 405, body: { error: { code: "method_not_allowed" } } } }, async (origin) => {
    const r = await classifyLive(origin, op("POST", "/api/thing"));
    assert.equal(r.verdict, "method_mismatch");
  });
});

test("classifyLive: double 404 is not_served", async (t) => {
  await withStubServer(t, {}, async (origin) => {
    const r = await classifyLive(origin, op("GET", "/api/nope"));
    assert.equal(r.verdict, "not_served");
  });
});

test("classifyLive: 404 on documented method but alternate answers is ok (resource miss)", async (t) => {
  await withStubServer(t, { "POST /api/thing": { status: 401 } }, async (origin) => {
    // documented GET 404s; alternate POST answers 401 -> the route exists,
    // the 404 was a resource miss inside the handler.
    const r = await classifyLive(origin, op("GET", "/api/thing"));
    assert.equal(r.verdict, "ok");
  });
});

test("classifyLive: open-write op never sends its documented method on a live origin", async (t) => {
  let seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "method_not_allowed" } }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found" } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const r = await classifyLive(origin, op("POST", "/api/guest-invites/request", []));
  assert.equal(r.verdict, "exists_unverified");
  assert.ok(!seen.some((s) => s.startsWith("POST")), `documented POST was sent: ${seen.join(", ")}`);
  assert.ok(seen.some((s) => s.startsWith("GET")), `alternate method was not probed: ${seen.join(", ")}`);
});

test("classifyLive: open-write op with double-404 is needs_review, not not_served", async (t) => {
  await withStubServer(t, {}, async (origin) => {
    const r = await classifyLive(origin, op("POST", "/api/join", []));
    assert.equal(r.verdict, "needs_review");
    assert.match(r.detail, /never sent/);
  });
});

test("classifyLive: allowWriteMethods sends the documented method (scratch only)", async (t) => {
  let seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(422, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "invalid_join" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const r = await classifyLive(origin, op("POST", "/api/join", []), { allowWriteMethods: true });
  assert.equal(r.verdict, "ok");
  assert.ok(seen.some((s) => s.startsWith("POST")), `documented POST was not sent: ${seen.join(", ")}`);
});

// ---------------------------------------------------------------------------
// Direction 2: live-served /api paths must be documented
// ---------------------------------------------------------------------------

test("undocumentedLivePaths: every live /api path documented -> empty", () => {
  const served = { paths: { "/api/version": {}, "/api/rooms/{roomId}/work-claims": {} } };
  const documented = ["/api/version", "/api/rooms/{id}/work-claims"];
  assert.deepEqual(undocumentedLivePaths(served, documented), []);
});

test("undocumentedLivePaths: undocumented live /api path is reported", () => {
  const served = { paths: { "/api/version": {}, "/api/secret-live-route": {} } };
  const documented = ["/api/version"];
  assert.deepEqual(undocumentedLivePaths(served, documented), ["/api/secret-live-route"]);
});

test("undocumentedLivePaths: non-/api discovery paths are out of scope", () => {
  const served = { paths: { "/.well-known/agent-card.json": {}, "/llms.txt": {}, "/openapi.json": {} } };
  assert.deepEqual(undocumentedLivePaths(served, ["/api/version"]), []);
});

// ---------------------------------------------------------------------------
// Fail-first regression: full sweep against this tree's scratch server
// ---------------------------------------------------------------------------

test("live sweep --check: every documented operation is served by this tree (zero drift)", async (t) => {
  const { origin, close } = await serveScratch();
  t.after(close);
  const { failures, summary } = await sweepLive({
    openapiText,
    origin,
    probeDelayMs: 0,
    allowWriteMethods: true,
    skipWorkerOnly: true, // the edge worker serves these, not the scratch server
    userAgent: "openapi-live-sweep-test/1.0",
  });
  assert.equal(summary.undocumentedLiveApiPaths.length, 0, `undocumented live paths: ${summary.undocumentedLiveApiPaths.join(", ")}`);
  assert.deepEqual(
    failures.map((f) => `${f.method} ${f.path}`),
    [],
    `drift:\n${renderSummary({ summary, failures })}`
  );
  assert.ok(summary.checked >= 500, `expected >=500 operations swept, got ${summary.checked}`);
}, { timeout: 600000 });
