// TASKS.md task 16: method-level OpenAPI contract accuracy.
// The template gate (tests/route-docs-check.test.js) pins path coverage;
// these tests pin the runtime half — every operation in docs/openapi.yaml
// must be served with its documented method — and the classifier the
// probe depends on.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classify, concrete, probeMethodAccuracy, renderReport } from "../scripts/openapi-method-accuracy.mjs";

test("classifier: 405 on the documented method is a method mismatch", () => {
  assert.equal(classify({ status: 405, code: "method_not_allowed", other404: false }).verdict, "method_mismatch");
  assert.equal(classify({ status: 405, code: null, other404: false }).verdict, "method_mismatch");
});

test("classifier: double 404 is not served; single 404 is a resource miss", () => {
  assert.equal(classify({ status: 404, code: "not_found", other404: true }).verdict, "not_served");
  assert.equal(classify({ status: 404, code: "not_found", other404: false }).verdict, "ok");
});

test("classifier: everything else holds (auth, validation, success)", () => {
  for (const [status, code] of [[200, null], [201, null], [400, "bad_request"], [401, "unauthorized"], [403, "forbidden"], [409, "conflict"], [422, "invalid"], [429, "rate_limited"]])
    assert.equal(classify({ status, code, other404: false }).verdict, "ok", `${status} ${code}`);
});

test("concrete() seeds the room id and dummies the rest", () => {
  assert.equal(concrete("/api/rooms/{roomId}/messages"), "/api/rooms/commons/messages");
  assert.equal(concrete("/api/agent-identities/{id}"), "/api/agent-identities/probe-id");
});

test("report renders a summary, mismatch section and operation table", () => {
  const results = [{ method: "GET", path: "/api/health", security: [], verdict: "ok", detail: "served (200)" }];
  const report = renderReport({ results, failures: [], served: 1 });
  assert.match(report, /Documented operations: 1/);
  assert.match(report, /\| GET \| `\/api\/health` \| open \| ok \|/);
  const failures = [{ method: "POST", path: "/api/x", security: null, verdict: "method_mismatch", detail: "d" }];
  assert.match(renderReport({ results: failures, failures, served: 1 }), /## Mismatches/);
});

test("every documented operation is served with its documented method", async () => {
  const openapi = readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8");
  const { failures, checked } = await probeMethodAccuracy({ openapi });
  assert.deepEqual(failures.map(f => `${f.method} ${f.path}: ${f.detail}`), []);
  assert.ok(checked >= 100, `checked ${checked}`);
});
