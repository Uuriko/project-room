// FO-DRIFT-3: POST /api/claims/validate answers 200 with a verdict and
// creates nothing. The served OpenAPI document must say 200, not 201.
import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenApiJson } from "../server/discoverability.mjs";

const spec = buildOpenApiJson({ origin: "https://room.example" });

test("served spec documents 200 (not 201) for POST /api/claims/validate", () => {
  const op = spec.paths["/api/claims/validate"]?.post;
  assert.ok(op, "operation is in the served spec");
  assert.ok(op.responses["200"], "200 documented");
  assert.equal(op.responses["201"], undefined, "201 not documented");
});

test("other POST creates keep their 201", () => {
  const op = spec.paths["/api/agent-identities"]?.post;
  assert.ok(op, "identity create is in the served spec");
  assert.ok(op.responses["201"], "201 still documented for a real create");
});
