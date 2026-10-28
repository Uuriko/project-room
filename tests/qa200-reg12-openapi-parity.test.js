// QA200-REG-12 regression sweep (2026-10-08): doc parity contract for
// docs/openapi.yaml vs the server's actual behavior.
//
// Failing-first: each assertion pins a server behavior landed in the last
// 14 days that docs/openapi.yaml omitted. The test REDs against the stale
// doc and turns GREEN once the doc is fixed.
//
//   1. 310ab6b3c (2026-10-07): GET /api/rooms/{roomId}/search gained
//      ?limit= (integer, 1..200, default 50, 422 invalid_search outside
//      range) and result.total (full match count across messages + work
//      items). The doc listed only q and kind.
//   2. 9e52eb987 (2026-10-07): POST /api/agent-heartbeats rejects
//      cadenceSeconds > 604800 (7 days) with 422 invalid_heartbeat.
//      The doc's cadenceSeconds schema had exclusiveMinimum: 0 but no
//      maximum, silently inviting agents to send values the server
//      rejects.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = parseYaml(readFileSync(join(ROOT, "docs", "openapi.yaml"), "utf8"));

test("docs/openapi.yaml: GET /api/rooms/{roomId}/search documents the limit cap and total count", t => {
  const op = doc.paths?.["/api/rooms/{roomId}/search"]?.get;
  assert.ok(op, "search operation is documented");

  const params = op.parameters ?? [];
  const limit = params.find(p => p.name === "limit" && p.in === "query");
  assert.ok(limit, "documents the limit query parameter");
  assert.equal(limit.schema?.type, "integer");
  assert.equal(limit.schema?.minimum, 1);
  assert.equal(limit.schema?.maximum, 200);
  assert.equal(limit.schema?.default, 50);

  const ok = op.responses?.["200"]?.content?.["application/json"]?.schema;
  assert.ok(ok, "documents the 200 response schema");
  assert.ok(ok.properties?.total, "documents the total full-match-count field");
  assert.equal(ok.properties.total.type, "integer");

  assert.ok(op.responses?.["422"], "documents the 422 invalid_search response for bad limit values");
});

test("docs/openapi.yaml: POST /api/agent-heartbeats cadenceSeconds documents the 7-day cap", t => {
  const op = doc.paths?.["/api/agent-heartbeats"]?.post;
  assert.ok(op, "heartbeat operation is documented");
  const cadence = op.requestBody?.content?.["application/json"]?.schema?.properties?.cadenceSeconds;
  assert.ok(cadence, "documents cadenceSeconds");
  assert.equal(cadence.maximum, 604800, "documents the server's 7-day (604800s) upper bound");
});
