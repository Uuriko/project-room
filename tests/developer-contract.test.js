import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { routeDocsDrift } from "../scripts/route-docs-check.mjs";

// D8: the public developer contract (quickstart, OpenAPI, error taxonomy,
// versions) must reconcile with the implementation so an outside agent can
// trust the documented examples, errors and versions without drift.

const openapi = readFileSync("docs/openapi.yaml", "utf8");
const quickstart = readFileSync("docs/AGENT-QUICKSTART.md", "utf8");
const taxonomy = readFileSync("docs/ERROR-TAXONOMY.md", "utf8");
const http = readFileSync("server/http.mjs", "utf8");
const pluginRoutes = readFileSync("server/agent-plugin-routes.mjs", "utf8");
const nextActionsRoutes = readFileSync("server/next-actions-routes.mjs", "utf8");
const discovery = readFileSync("deploy/agent-discovery.mjs", "utf8");
const hostMatrix = readFileSync("docs/HOST-MATRIX.md", "utf8");
const agentError = readFileSync("src/agent-error.mjs", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const serverSources = ["server/http.mjs", "server/store.mjs", "src/agent-error.mjs", "client/work-actions.mjs"]
  .map(path => readFileSync(path, "utf8")).join("\n");

function openapiOperations(text) {
  const ops = []; let current = null;
  for (const line of text.split("\n")) {
    const path = /^  (\/\S+):\s*$/.exec(line);
    if (path) { current = path[1]; continue; }
    const method = /^    (get|post|put|delete|patch):\s*$/.exec(line);
    if (method && current) ops.push({ method: method[1].toUpperCase(), path: current });
  }
  return ops;
}
const documented = openapiOperations(openapi);
assert.ok(documented.length >= 15, "openapi parse sanity");

test("every quickstart API example is an operation in the OpenAPI contract", () => {
  const examples = [...quickstart.matchAll(/^(GET|POST|PUT|DELETE|PATCH) (\/api\/\S+)/gm)]
    .map(m => ({ method: m[1], path: m[2].replaceAll(":roomId", "{roomId}").replace(/\s.*$/, "") }));
  assert.ok(examples.length >= 8, "quickstart example sanity");
  for (const example of examples) {
    assert.ok(documented.some(op => op.method === example.method && op.path === example.path),
      `quickstart documents ${example.method} ${example.path} but openapi.yaml does not`);
  }
});

test("non-API quickstart endpoints are served by the documented discovery surface", () => {
  const wellKnown = [...quickstart.matchAll(/^(GET) (\/.well-known\/\S+)/gm)].map(m => m[2]);
  assert.ok(wellKnown.length >= 1, "quickstart well-known sanity");
  for (const path of wellKnown) assert.ok(discovery.includes(`"${path}"`), `${path} missing from deploy/agent-discovery.mjs`);
});

test("every OpenAPI path is a route template the server serves, and every served template is documented", () => {
  // Shared with the npm run check gate (scripts/route-docs-check.mjs): the
  // served set is extracted from server/http.mjs string literals and anchored
  // path regexes plus the agent plug-in surface in
  // server/agent-plugin-routes.mjs and the next-actions surface in
  // server/next-actions-routes.mjs, parameters reduced to {} on both sides.
  const { failures, served, documented } = routeDocsDrift({ http, pluginRoutes, nextActionsRoutes, openapi });
  assert.deepEqual(failures, []);
  assert.ok(served >= 60 && served === documented, `served ${served}, documented ${documented}`);
});

test("documented error categories and codes exist in the implementation", () => {
  const categories = [...taxonomy.matchAll(/^\| `([a-z_]+)` \|/gm)].map(m => m[1]);
  assert.deepEqual(categories.sort(), ["access", "conflict", "input", "internal", "not_found", "rate_limited", "unavailable"].sort());
  for (const category of categories) assert.ok(agentError.includes(`"${category}"`), `category ${category} missing from src/agent-error.mjs`);
  for (const code of ["session_claimed", "idempotency_conflict", "command_rejected", "halt_active"])
    assert.ok(serverSources.includes(`"${code}"`), `documented code ${code} missing from implementation`);
  assert.match(serverSources, /stale_[a-z_]+_revision/, "documented stale_*_revision family missing from implementation");
});

test("documented versions reconcile with the release identity", () => {
  const openapiVersion = /^  version: (\S+)$/m.exec(openapi)?.[1];
  assert.equal(openapiVersion, pkg.version, "openapi info.version must match package.json version");
});

test("documented MCP protocol versions match the adapter's supported eras", async () => {
  const { MCP_SUPPORTED_VERSIONS } = await import("../client/mcp-stdio.mjs");
  for (const version of MCP_SUPPORTED_VERSIONS)
    assert.ok(hostMatrix.includes(version), `HOST-MATRIX missing supported MCP era ${version}`);
});
