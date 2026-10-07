// openapi-naming-contract: the wire naming contract for docs/openapi.yaml.
//
// Contract: every schema property name and every parameter name in the
// OpenAPI spec is camelCase, except the pinned GRANDFATHERED set below.
// Rationale: the API is overwhelmingly camelCase (400+ names); the 36
// snake_case names are historical islands (the retired board-v2 surface,
// the /api/web/* fetch/research helpers, the feedback surface, and two
// singletons). An agent coding against the API should be able to assume
// camelCase for any NEW field; a new snake_case name is a contract break
// for every client that guessed the camelCase spelling.
//
// The gate pins the CURRENT snake_case set exactly: a new snake_case name
// fails (rename it to camelCase, or justify it in GRANDFATHERED), and a
// grandfathered name that disappears from the spec fails as a stale entry
// (remove it from GRANDFATHERED).
//
// Authoring-gate answers (.agents/skills/test-audit/SKILL.md):
// 1. Protects the public wire-naming contract agents code against.
// 2. Credible regression: a lane documents a new endpoint with a
//    snake_case field (the feedback and web-fetch surfaces both did this
//    when they were added) — the gate fails naming the field.
// 3. Existing coverage: route-docs-check pins path templates,
//    openapi-method-accuracy pins methods, mcp-openapi-drift pins MCP tool
//    request shapes vs OpenAPI — none inspects naming style.
// 4. No production seam: parses docs/openapi.yaml off disk with the yaml
//    package (already a dependency). No new exports.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const openapi = parse(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));

// name -> why it stays snake_case (backward compatibility: each is live on
// the wire and documented; renaming would break existing clients).
const GRANDFATHERED = {
  // Retired board v2 (serves board_v2_retired; schemas frozen).
  claim_at: "BoardV2Claim (retired surface)",
  claim_ref: "BoardV2Finding (retired surface)",
  comment_id: "board v2 mirror-map (retired surface)",
  expires_at: "BoardV2Claim (retired surface)",
  file_claims: "board v2 claims/board responses (retired surface)",
  has_more: "board v2 events (retired surface)",
  heartbeat_at: "BoardV2Claim (retired surface)",
  idempotency_key: "BoardV2Event (retired surface)",
  last_seq: "BoardV2Claim (retired surface)",
  lease_h: "BoardV2Claim (retired surface)",
  live_claims: "board v2 health (retired surface)",
  mirror_entries: "board v2 health (retired surface)",
  pr_ref: "BoardV2Finding (retired surface)",
  since_seq: "board v2 query params (retired surface)",
  task_id: "board v2 request/response (retired surface)",
  // /api/web/* helpers: server/web-fetch.mjs returns cache_metadata{status, age_ms}.
  age_ms: "POST /api/web/fetch + /api/web/research cache metadata",
  cache_metadata: "POST /api/web/fetch response",
  content_sha256: "POST /api/web/research evidence.provenance",
  fetch_errors: "POST /api/web/research response",
  final_url: "POST /api/web/research evidence.provenance",
  plan_only: "POST /api/web/research response",
  provider_errors: "POST /api/web/research response",
  provider_status: "POST /api/web/research response",
  request_id: "POST /api/web/fetch + /api/web/research (also echoed in descriptions)",
  retrieved_at: "POST /api/web/research evidence.provenance",
  // Feedback surface: server/feedback-routes.mjs wire shape.
  card_uri: "POST /api/rooms/{roomId}/feedback requestBody.agent",
  cluster_key: "feedback responses",
  feedback_id: "feedback responses",
  key_id: "POST /api/rooms/{roomId}/feedback requestBody.agent",
  mark_balance: "feedback responses",
  promoted_task: "feedback triage/appeal-decision responses",
  triaged_at: "GET /api/rooms/{roomId}/feedback/{feedbackId}",
  verdict_url: "POST /api/rooms/{roomId}/feedback 202",
  your_mark: "GET /api/rooms/{roomId}/feedback 200",
  // Singletons (live on the wire, documented).
  canonical_id: "POST /api/rooms/{roomId}/bounties/{bountyId}/duplicate requestBody",
  since_version: "GET /api/rooms/{roomId}/context query param (+ get_room_context MCP tool)",
};

function resolveRef(schema) {
  if (schema && typeof schema === "object" && typeof schema.$ref === "string" && Object.keys(schema).length === 1) {
    const m = schema.$ref.match(/^#\/components\/schemas\/(\w+)$/);
    if (m && openapi.components?.schemas?.[m[1]]) return openapi.components.schemas[m[1]];
  }
  return schema;
}

function harvest() {
  const names = new Map(); // name -> Set(locations)
  const add = (name, loc) => {
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(loc);
  };
  const walk = (schema, loc) => {
    if (!schema || typeof schema !== "object") return;
    if (schema.properties && typeof schema.properties === "object") {
      for (const [k, v] of Object.entries(schema.properties)) {
        add(k, loc);
        walk(resolveRef(v), `${loc}.${k}`);
      }
    }
    for (const key of ["items", "additionalProperties"]) {
      if (schema[key] && typeof schema[key] === "object") walk(resolveRef(schema[key]), loc);
    }
    for (const key of ["allOf", "oneOf", "anyOf"]) {
      if (Array.isArray(schema[key])) schema[key].forEach((s, i) => walk(resolveRef(s), `${loc}.${key}[${i}]`));
    }
  };
  for (const [path, item] of Object.entries(openapi.paths || {})) {
    for (const [method, op] of Object.entries(item || {})) {
      if (!op || typeof op !== "object") continue;
      if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) continue;
      const oploc = `${method.toUpperCase()} ${path}`;
      for (const prm of [...(item.parameters || []), ...(op.parameters || [])]) {
        if (prm?.$ref) continue; // shared params (RoomId) are camelCase by inspection
        if (prm?.name) add(prm.name, `${oploc} param(${prm.in})`);
      }
      for (const [code, resp] of Object.entries(op.responses || {})) {
        const s = resp?.content?.["application/json"]?.schema;
        if (s) walk(resolveRef(s), `${oploc} ${code}`);
      }
      const rb = op.requestBody?.content?.["application/json"]?.schema;
      if (rb) walk(resolveRef(rb), `${oploc} requestBody`);
    }
  }
  for (const [sname, s] of Object.entries(openapi.components?.schemas || {})) {
    walk(resolveRef(s), `#/components/schemas/${sname}`);
  }
  return names;
}

const isSnakeCase = name => /[a-z]_[a-z]/.test(name) && !/[a-z][A-Z]/.test(name);

test("spec wire names are camelCase except the grandfathered snake_case set", () => {
  const names = harvest();
  assert.ok(names.size > 500, `harvested only ${names.size} names; the walker likely regressed`);
  const snake = [...names.keys()].filter(isSnakeCase).sort();
  const grandfathered = Object.keys(GRANDFATHERED).sort();
  const unexpected = snake.filter(n => !grandfathered.includes(n));
  const stale = grandfathered.filter(n => !snake.includes(n));
  const problems = [
    ...unexpected.map(n => `new snake_case name "${n}" (e.g. ${[...names.get(n)].slice(0, 2).join(" | ")}) — rename to camelCase or justify it in GRANDFATHERED`),
    ...stale.map(n => `grandfathered "${n}" no longer appears in the spec — remove it from GRANDFATHERED`),
  ];
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("grandfathered entries carry a justification", () => {
  const unjustified = Object.entries(GRANDFATHERED).filter(([, why]) => !why || why.length < 10);
  assert.deepEqual(unjustified.map(([n]) => n), [], "grandfathered names without justification");
});
