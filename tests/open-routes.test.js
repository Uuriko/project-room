// B48: the open-route inventory helper. The openapi extraction is line-based
// (no YAML reader in the repo), so pin exactly what it reads and refuses.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openapiOperations, openRoutes, pathParameterSamples, routeCandidates, routeKey, documents, docsDrift, checklistSection1 } from "../scripts/open-routes.mjs";

const spec = `openapi: 3.1.0
info:
  description: |
    Not a route:
      security: []
security:
  - bearerAuth: []
paths:
  /api/open:
    get:
      summary: Open
      security: []
      responses:
        '200': { description: ok }
    post:
      summary: Inherits the document default
      responses:
        '201': { description: ok }
  /api/cookie/{id}:
    parameters:
      - name: id
        in: path
    post:
      description: |
        A block scalar mentioning security: [] must not count.
      security:
        - accountSession: []
        - other: [scope]
      responses:
        '200': { description: ok }
    delete:
      security: []
      responses:
        '200': { description: ok }
components:
  securitySchemes:
    x:
      security: []
`;

test("openapiOperations reads method, path and security per operation", () => {
  // parameterLines is compared on its own below; here only the three fields
  // this function existed for.
  const shape = text => openapiOperations(text).map(({ method, path, security }) => ({ method, path, security }));
  assert.deepEqual(shape(spec), [
    { method: "GET", path: "/api/open", security: [] },
    { method: "POST", path: "/api/open", security: null },
    { method: "POST", path: "/api/cookie/{id}", security: ["accountSession", "other"] },
    { method: "DELETE", path: "/api/cookie/{id}", security: [] },
  ]);
  assert.deepEqual(openRoutes(spec), [{ method: "GET", path: "/api/open" }, { method: "DELETE", path: "/api/cookie/{id}" }]);
  assert.throws(() => openapiOperations("paths:\n  /x:\n    get:\n      security: [{ a: [] }]\n"), /unsupported inline security/);
});

test("the real spec declares the account-session inbox routes guarded and the webhook open", () => {
  const ops = openapiOperations(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));
  const by = (method, path) => ops.find(op => op.method === method && op.path === path)?.security;
  assert.deepEqual(by("GET", "/api/inbox/connections"), ["accountSession"]);
  assert.deepEqual(by("POST", "/api/inbox/connections/{id}/reconnect"), ["accountSession"]);
  assert.deepEqual(by("POST", "/api/inbox/webhooks/{connectionId}"), []);
  assert.deepEqual(by("POST", "/api/agent-identities"), []);
  assert.deepEqual(by("POST", "/api/identity-create"), []);
  assert.equal(by("POST", "/api/rooms/{roomId}/commands"), null);
});

test("routeCandidates expands string literals and anchored path regexes", () => {
  const source = `
    if (url.pathname === "/api/health") {}
    if (url.pathname.startsWith("/api/inbox/")) {}
    const routes = { read: "/api/inbox/connections/{id}" };
    const a = /^\\/api\\/rooms\\/([^/]{1,384})(?:\\/(commands|events))?$/.exec(p);
    const b = /^\\/api\\/rooms\\/([^/]{1,384})\\/messages\\/([^/]{1,384})\\/thread$/.exec(p);
    const c = /^\\/api\\/inbox\\/sources\\/([^/]{1,384})\\/reply-review$/.exec(p);
  `;
  assert.deepEqual(routeCandidates(source), [
    "/api/health", "/api/inbox/connections/{id}", "/api/inbox/sources/{id}/reply-review",
    "/api/rooms/{id}", "/api/rooms/{id}/commands", "/api/rooms/{id}/events", "/api/rooms/{id}/messages/{id}/thread",
  ]);
  assert.throws(() => routeCandidates("/^\\/api\\/x\\/(a|b)$/"), /not expanded/);
  assert.equal(routeKey("POST", "/api/inbox/webhooks/{connectionId}"), routeKey("POST", "/api/inbox/webhooks/{id}"));
});

test("documents matches :param spellings and whole paths only", () => {
  assert.ok(documents("| `POST /api/inbox/webhooks/:connectionId` |", "/api/inbox/webhooks/{connectionId}"));
  assert.ok(documents("`/api/inbox/webhooks/:id`", "/api/inbox/webhooks/{connectionId}"));
  assert.ok(documents("`GET /api/health`, `/api/version`", "/api/version"));
  assert.ok(!documents("`POST /api/guest-agent-links/preview`", "/api/guest-agent-links"));
  assert.ok(!documents("`/api/health-check`", "/api/health"));
});

test("docsDrift names each document missing an open route, checklist section 1 only", () => {
  const checklist = "# Title\n\n## 1. Access\n\n`GET /api/health`\n\n## 2. Other\n\n`POST /api/session`\n";
  assert.deepEqual(checklistSection1(checklist).trim(), "## 1. Access\n\n`GET /api/health`");
  const routes = [{ method: "GET", path: "/api/health" }, { method: "POST", path: "/api/session" }];
  assert.deepEqual(docsDrift({ routes, routeAuthTable: "`/api/session`", checklist }), [
    "docs/ROUTE-AUTH-TABLE.md does not list open route GET /api/health",
    "docs/INVITE-ONLY-CHECKLIST.md section 1 does not list open route POST /api/session",
  ]);
  assert.throws(() => checklistSection1("no sections"), /sections 1 and 2/);
});

// A path parameter the server constrains cannot be probed with a dummy value.
// The spec already publishes the vocabulary for those; these cover reading it
// back out of both spellings the document uses.
test("pathParameterSamples reads a declared enum and an example, in either spelling", () => {
  assert.deepEqual(pathParameterSamples([
    "        - { name: action, in: path, required: true, schema: { type: string, enum: [rotate, revoke] } }",
  ]), { action: "rotate" }, "the first enum entry stands for the whole vocabulary");

  assert.deepEqual(pathParameterSamples([
    "        - name: keyId",
    "          in: path",
    "          required: true",
    "          example: rak_example",
    "          schema: { type: string }",
  ]), { keyId: "rak_example" });

  assert.deepEqual(pathParameterSamples([
    "        - { name: roomId, in: path, required: true, schema: { type: string } }",
  ]), {}, "a parameter that declares no vocabulary takes the caller's dummy");

  assert.deepEqual(pathParameterSamples([
    "        - { name: order, in: query, required: false, schema: { type: string, enum: [asc, desc] } }",
  ]), {}, "query parameters are not path segments");

  assert.deepEqual(pathParameterSamples([]), {}, "an operation with no parameters block");
});

test("the spec publishes enough to reach /api/agent-keys/{keyId}/{action}", () => {
  // The one route today with two constrained segments, and the reason this
  // exists: the probe built /api/agent-keys/probe-id/probe-id, which matches
  // nothing, and the accuracy check reported a served route as unserved. The
  // server's own regex is read from source rather than copied, so a change to
  // the route shape fails here instead of drifting.
  const source = readFileSync(new URL("../server/agent-plugin-routes.mjs", import.meta.url), "utf8");
  const declared = /const KEY_ACTION_ROUTE = (\/\^.*?\$\/);/.exec(source);
  assert.ok(declared, "KEY_ACTION_ROUTE is still declared in server/agent-plugin-routes.mjs");
  const route = new RegExp(declared[1].slice(1, -1));

  const operation = openapiOperations(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8")).find(op => op.path === "/api/agent-keys/{keyId}/{action}");
  assert.ok(operation, "the operation is still documented");
  const samples = pathParameterSamples(operation.parameterLines);
  const path = operation.path.replace(/\{([^}]*)\}/g, (_, name) => samples[name] ?? "probe-id");

  assert.match(path, route, "the spec's own sample values build a path the server matches");
  assert.doesNotMatch("/api/agent-keys/probe-id/probe-id", route, "and dummies do not, which is the bug");
});
