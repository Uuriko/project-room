// Route body schema honesty (bughunt 2026-10-04).
//
// schemaErrors is the only runtime enforcer of route-table body schemas, and
// its typeOf never produced "integer" — so every schema declaring
// type:"integer" silently rejected EVERY value (422 invalid_body), including
// sessionRevision on five auth routes and step on inbox.setup.write. A second
// family (inbox.connections.reconnect/sync, inbox.simulation) declared
// required fields with additionalProperties:false but no `properties`, so
// every well-formed body was rejected as "not allowed".
import test from "node:test";
import assert from "node:assert/strict";
import { schemaErrors } from "../server/routes/dispatch.mjs";
import { ROUTES, assertRouteTable } from "../server/routes/table.mjs";

const byId = Object.fromEntries(ROUTES.map(row => [row.id, row]));
const bodyOf = id => byId[id]?.schema?.body;

test("schemaErrors honors the JSON-Schema integer type", () => {
  const schema = { type: "object", properties: { n: { type: "integer" } } };
  for (const good of [0, 5, -3, 2 ** 40]) {
    assert.deepEqual(schemaErrors(schema, { n: good }), [], `integer accepts ${good}`);
  }
  for (const bad of [1.5, "5", NaN, null, {}, [], true]) {
    assert.ok(schemaErrors(schema, { n: bad }).length > 0, `integer rejects ${String(bad)}`);
  }
});

test("schemaErrors honors a type array", () => {
  const schema = { type: "object", properties: { u: { type: ["array", "null"] } } };
  assert.deepEqual(schemaErrors(schema, { u: [] }), []);
  assert.deepEqual(schemaErrors(schema, { u: null }), []);
  assert.ok(schemaErrors(schema, { u: "x" }).length > 0);
});

test("no route-table schema uses a type the validator cannot enforce", () => {
  const known = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
  const walk = (schema, seen) => {
    if (!schema || typeof schema !== "object") return;
    if (schema.type !== undefined) {
      for (const t of Array.isArray(schema.type) ? schema.type : [schema.type]) {
        if (!known.has(t)) seen.push(t);
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const key of Object.keys(schema.properties)) walk(schema.properties[key], seen);
    }
    if (schema.items) walk(schema.items, seen);
  };
  for (const row of ROUTES) {
    const unknown = [];
    for (const key of ["params", "query", "body", "response"]) walk(row.schema?.[key], unknown);
    assert.deepEqual(unknown, [], `${row.id}: unknown schema type(s) ${unknown.join(",")}`);
  }
});

test("assertRouteTable fails closed on an unknown schema type", () => {
  const row = {
    id: "probe.bad-type", method: "POST", path: "/api/probe", auth: "none",
    capability: null, handler() {}, events: [], scope: "public",
    schema: { body: { type: "object", properties: { n: { type: "int" } } } },
  };
  assert.throws(() => assertRouteTable([row]), /unknown type/);
});

test("auth bodies accept a numeric sessionRevision", () => {
  const bodies = {
    "auth.magic.consume": { email: "a@b.c", code: "123456", sessionRevision: 3 },
    "auth.password.reset.consume": { email: "a@b.c", code: "123456", newPassword: "long-enough-pw", sessionRevision: 3 },
    "auth.password.signup": { email: "a@b.c", password: "long-enough-pw", sessionRevision: 3 },
    "auth.password.login": { email: "a@b.c", password: "long-enough-pw", sessionRevision: 3 },
    "auth.passkey.authenticate.finish": { challengeId: "ch-1", response: {}, sessionRevision: 3 },
  };
  for (const [id, body] of Object.entries(bodies)) {
    const schema = bodyOf(id);
    assert.ok(schema, `${id} has a body schema`);
    // Only the fields the route's required list demands are filled; optional
    // fields are irrelevant to the regression (a numeric sessionRevision).
    const minimal = {};
    for (const key of schema.required ?? []) minimal[key] = body[key];
    assert.deepEqual(schemaErrors(schema, minimal), [], `${id} accepts numeric sessionRevision`);
  }
});

test("inbox.setup.write accepts a numeric step", () => {
  const schema = bodyOf("inbox.setup.write");
  assert.deepEqual(
    schemaErrors(schema, { name: "n", purpose: "p", platforms: [], step: 2, completed: false }),
    [],
  );
});

test("spend-grant issue body accepts an integer expiresAt and rejects a float", () => {
  const schema = bodyOf("issue-spend-grant");
  const base = { agentId: "peer1", capCents: "100", perTxCapCents: "10" };
  assert.deepEqual(schemaErrors(schema, { ...base, expiresAt: Date.now() + 60000 }), []);
  assert.ok(schemaErrors(schema, { ...base, expiresAt: 1.5 }).length > 0);
});

test("inbox reconnect/sync/simulation bodies accept their documented shapes", () => {
  assert.deepEqual(
    schemaErrors(bodyOf("inbox.connections.reconnect"), { requestId: "req-1" }),
    [],
  );
  assert.deepEqual(
    schemaErrors(bodyOf("inbox.connections.sync"), { requestId: "req-1", updates: [] }),
    [],
  );
  assert.deepEqual(
    schemaErrors(bodyOf("inbox.connections.sync"), { requestId: "req-1", updates: null }),
    [],
  );
  assert.deepEqual(
    schemaErrors(bodyOf("inbox.simulation"), { action: "dispatch", sourceId: "src-1", sendId: "send-1" }),
    [],
  );
  assert.ok(
    schemaErrors(bodyOf("inbox.simulation"), { action: "explode", sourceId: "src-1", sendId: "send-1" }).length > 0,
    "simulation still rejects an unknown action",
  );
});
