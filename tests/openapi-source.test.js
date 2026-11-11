// The published contract is the document rendered from
// server/openapi/fragments. The route gate reads that rendering. A committed
// snapshot diff is not the check.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { openApiGateProblems, openApiParseErrors } from "../scripts/openapi-gen.mjs";
import { renderOpenApi } from "../scripts/openapi-document.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("fragments render a valid OpenAPI document the route gate accepts", () => {
  const text = renderOpenApi(root);
  assert.deepEqual(openApiParseErrors(text), []);
  const doc = parse(text);
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(typeof doc.paths, "object");
  assert.ok(Object.keys(doc.paths).length > 20);
  assert.deepEqual(openApiGateProblems(root), []);
});

// Regeneration must not erase already-published OAuth or receipt contracts.
test("rendered fragments retain OAuth authorization and bounty-lot receipts", () => {
  const doc = parse(renderOpenApi(root));
  assert.ok(doc.paths["/oauth/authorize"]?.get);
  assert.ok(doc.paths["/oauth/authorize"]?.post);
  const source = doc.paths["/api/public/receipts"].get.responses["200"].content["application/json"].schema.properties.receipts.items.properties.source;
  assert.ok(source.enum.includes("bounty-lot"));
});
