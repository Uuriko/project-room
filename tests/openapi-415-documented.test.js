// REL-21: every route that reads a JSON body answers a non-JSON Content-Type
// with 415 json_required. The served spec must list 415 there and nowhere else.
import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenApiJson, readsJsonBody } from "../server/discoverability.mjs";

const doc = buildOpenApiJson({ origin: "http://127.0.0.1" });
const ops = Object.entries(doc.paths).flatMap(([path, item]) => Object.entries(item).map(([m, op]) => ({ path, method: m.toUpperCase(), op })));

test("415 is documented on every body-reading operation and resolves to a component", () => {
  const body = ops.filter(o => ["POST", "PUT", "PATCH"].includes(o.method) && !["/a2a", "/mcp", "/room/mcp"].includes(o.path)
    && !["/api/agent-webhooks/deliveries/{deliveryId}/redrive", "/api/oauth/sessions/revoke-all"].includes(o.path));
  assert.ok(body.length >= 25, `expected the body routes, got ${body.length}`);
  for (const { path, method, op } of body) assert.deepEqual(op.responses["415"], { $ref: "#/components/responses/UnsupportedMediaType" }, `${method} ${path}`);
  assert.match(doc.components.responses.UnsupportedMediaType.description, /json_required/);
});

test("415 is not documented on reads, JSON-RPC doors, or POSTs that read no body", () => {
  for (const { path, method, op } of ops) {
    if (["GET", "HEAD"].includes(method)) assert.equal(op.responses["415"], undefined, `${method} ${path}`);
  }
  for (const p of ["/a2a", "/mcp", "/room/mcp", "/api/agent-webhooks/deliveries/{deliveryId}/redrive", "/api/oauth/sessions/revoke-all"]) {
    assert.equal(doc.paths[p]?.post?.responses["415"], undefined, p);
  }
});

test("a DELETE with a documented body gets 415, a bare DELETE does not", () => {
  assert.equal(readsJsonBody({ path: "/x", requestBodies: { DELETE: {} } }, "DELETE"), true);
  assert.equal(readsJsonBody({ path: "/x" }, "DELETE"), false);
  const inv = doc.paths["/api/rooms/{roomId}/agent-invites"]?.delete;
  if (inv?.requestBody) assert.ok(inv.responses["415"]);
});
