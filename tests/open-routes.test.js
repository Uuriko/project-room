// B48: the open-route inventory helper. The openapi extraction is line-based
// (no YAML reader in the repo), so pin exactly what it reads and refuses.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openapiOperations, openRoutes, routeCandidates, routeKey, documents, docsDrift, checklistSection1 } from "../scripts/open-routes.mjs";

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
  assert.deepEqual(openapiOperations(spec), [
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
