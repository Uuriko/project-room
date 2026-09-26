import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { routeDocsDrift, routeSources, templateKey, workerRouteTemplates } from "../scripts/route-docs-check.mjs";

// Re-audit 2026-09-14, M4: docs/openapi.yaml describes every /api route
// template server/http.mjs serves. The npm run check gate runs the same
// comparison; these tests pin its two failure directions and the template
// normalisation so the gate itself cannot silently go blind.
//
// RC-2026-09-19-081: the fixtures and the gate share routeSources() — the
// agent plug-in surface (server/agent-plugin-routes.mjs) used to be fed to
// the gate but not to these tests, failing 4/5 while the gate stayed green.
const sources = routeSources(fileURLToPath(new URL("..", import.meta.url)));
const { http, pluginRoutes, nextActionsRoutes, worker, openapi } = sources;
const shared = { http, pluginRoutes, nextActionsRoutes, worker, openapi };

test("parameter spellings compare equal", () => {
  assert.equal(templateKey("/api/rooms/{roomId}/messages/{messageId}/thread"), "/api/rooms/{}/messages/{}/thread");
  assert.equal(templateKey("/api/rooms/{id}/agent-invites"), templateKey("/api/rooms/{roomId}/agent-invites"));
  assert.equal(templateKey("/api/rooms/:roomId"), templateKey("/api/rooms/{roomId}"));
});

test("the served route templates and the documented paths agree", () => {
  const result = routeDocsDrift(shared);
  assert.deepEqual(result.failures, []);
  assert.ok(result.served >= 60, `served ${result.served}`);
  assert.equal(result.documented, result.served);
});

// RC-2026-09-26-002: the Worker-served surface (cloudflare/room.mjs) is a
// first-class route source. Routes the Worker answers before or instead of
// the Durable Object were invisible to the gate until now.
test("worker-served routes are extracted, trailing-slash siblings folded", () => {
  const templates = workerRouteTemplates(worker);
  assert.ok(templates.includes("/api/health/jobs"), "the Worker cron heartbeat route is in the inventory");
  assert.ok(!templates.some(template => template.endsWith("/")), "trailing-slash variants fold into the base route");
});

test("a Worker-served route missing from the spec fails, naming the template", () => {
  const withRoute = worker.replace("url.pathname === '/api/health/jobs/'",
    "url.pathname === '/api/health/jobs/' || url.pathname === '/api/worker-only-undocumented'");
  const { failures } = routeDocsDrift({ ...shared, worker: withRoute });
  assert.deepEqual(failures, ["served but not documented in docs/openapi.yaml: /api/worker-only-undocumented"]);
});

test("the gate refuses a blind inventory when the worker source is omitted", () => {
  const { worker: _omitted, ...withoutWorker } = shared;
  assert.throws(() => routeDocsDrift(withoutWorker), /needs cloudflare\/room\.mjs/);
});

test("a served route missing from the spec fails, naming the template", () => {
  const withRoute = http.replace('"/api/health"', '"/api/health" + "/api/not-yet-documented"');
  const { failures } = routeDocsDrift({ ...shared, http: withRoute });
  assert.deepEqual(failures, ["served but not documented in docs/openapi.yaml: /api/not-yet-documented"]);
});

test("a documented path the server no longer serves fails", () => {
  const stale = openapi.replace("  /api/rooms/{roomId}/charter:\n", "  /api/rooms/{roomId}/charter-archive:\n");
  const { failures } = routeDocsDrift({ ...shared, openapi: stale });
  assert.deepEqual(failures, [
    "served but not documented in docs/openapi.yaml: /api/rooms/{id}/charter",
    "documented in docs/openapi.yaml but not served: /api/rooms/{roomId}/charter-archive",
  ]);
});

test("account routes must declare their scheme instead of inheriting the room default", () => {
  const inherited = openapi.replace("  /api/account-rooms:\n    get:\n      summary: List the account's current rooms\n      description: |\n        Browser account-session route (account_session cookie plus\n        X-Session-Binding). Bounded pages of the memberships the account holds\n        right now; a left or revoked membership is gone on the next read.\n        Each entry carries `kind` (personal or organization) and\n        `archived` / `archivedAt`; archived rooms stay listed and readable.\n      security:\n        - accountSession: []\n",
    "  /api/account-rooms:\n    get:\n      summary: List the account's current rooms\n");
  assert.notEqual(inherited, openapi, "fixture edit applied");
  const { failures } = routeDocsDrift({ ...shared, openapi: inherited });
  assert.deepEqual(failures, ["GET /api/account-rooms inherits the room-credential default; account routes must declare accountSession or security: []"]);
});
