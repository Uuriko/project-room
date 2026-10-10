// johnstab-mcp-openapi-drift: CI drift gate — MCP tool input schemas vs
// OpenAPI request schemas for the same logical operations.
//
// Contract: every MCP tool whose description claims "Same call/read as
// METHOD /path" must accept the same request shape as the documented
// OpenAPI operation (parameter names, required fields, types), modulo the
// documented allowances in ALLOW below.
//
// Authoring-gate answers (.agents/skills/test-audit/SKILL.md):
// 1. Protects the agent-facing contract behind each tool description's
//    "Same call as" sentence: an agent that can build a valid MCP call must
//    be able to build the equivalent REST call and vice versa. The two
//    sources are maintained by different lanes at different times, so this
//    is a genuine cross-source contract, not a self-comparison.
// 2. Credible regression: a lane adds `starter` to POST /api/agent-rooms
//    (real: server/agent-rooms.mjs CREATE_FIELDS) without adding it to the
//    room_create MCP tool — the gate fails naming the exact param.
// 3. Existing coverage: route-docs-check pins path templates,
//    openapi-method-accuracy pins methods, qa2-contract pins the OpenAPI
//    shape and the MCP tools list — none compares tool input schemas
//    against OpenAPI request schemas parameter by parameter.
// 4. No production seam: imports the already-exported tool registries and
//    reads docs/openapi.yaml off disk. No new exports, flags, or wrappers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  hostedMcpToolDefs,
  hostedRoomTools,
} from "../server/mcp-hosted-tools.mjs";
import { publicWorkMcpDefinitions } from "../server/mcp-public-work.mjs";

const openapi = parse(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));

// ---------------------------------------------------------------------------
// OpenAPI model
// ---------------------------------------------------------------------------

function resolveParamRef(obj) {
  if (obj && typeof obj === "object" && typeof obj.$ref === "string" && Object.keys(obj).length === 1) {
    const m = obj.$ref.match(/^#\/components\/parameters\/(\w+)$/);
    if (m && openapi.components?.parameters?.[m[1]]) return openapi.components.parameters[m[1]];
  }
  return obj;
}

function normType(t) {
  if (Array.isArray(t)) return [...t].sort().join("|");
  return t ?? null; // null = untyped (accepts any)
}

const templateKey = p => p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

function findOperation(method, pathTemplate) {
  const want = templateKey(pathTemplate);
  for (const [p, item] of Object.entries(openapi.paths || {})) {
    if (templateKey(p) !== want) continue;
    const op = item?.[method.toLowerCase()];
    if (op) return { path: p, op, item };
  }
  return null;
}

// Effective request parameters for one operation: path-level parameters,
// operation parameters, and the application/json requestBody properties.
// $refs to #/components/parameters/* are resolved.
function effectiveRequestParams(found) {
  const { op, item } = found;
  const out = new Map();
  for (const raw of [...(item.parameters || []), ...(op.parameters || [])]) {
    const prm = resolveParamRef(raw);
    const sch = resolveParamRef(prm.schema) || {};
    out.set(prm.name, {
      name: prm.name,
      location: prm.in,
      required: prm.in === "path" ? true : prm.required === true,
      type: normType(sch.type ?? sch.anyOf?.map(x => x?.type)),
      enum: sch.enum,
    });
  }
  const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
  for (const [name, sch] of Object.entries(bodySchema?.properties || {})) {
    out.set(name, {
      name,
      location: "body",
      required: (bodySchema.required || []).includes(name),
      type: normType(sch?.type ?? sch?.anyOf?.map(x => x?.type)),
      enum: sch?.enum,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool -> route mapping
// ---------------------------------------------------------------------------

// Tools whose description states the REST equivalent outright, e.g.
// "Same call as POST /api/agent-rooms." A trailing "and METHOD /path"
// continues the same claim (room_list_peer_dms names two routes).
function routeClaims(description) {
  const claims = [];
  const sentence = /Same (?:call|read|reads|store call) as ([^.]+)\./g;
  let sm;
  while ((sm = sentence.exec(description))) {
    const pair = /([A-Z]+)\s+([^\s,;]+)/g;
    let pm;
    while ((pm = pair.exec(sm[1]))) claims.push({ method: pm[1], path: pm[2].replace(/[:?]$/, "") });
  }
  return claims;
}

// Mappings documented outside the "Same … as" phrasing. Each entry cites
// where the equivalence is stated, so a reviewer can check the claim.
const SUPPLEMENT = [
  // docs/openapi.yaml, POST /mcp description: "public_work_claim,
  // public_work_renew, public_work_release, public_work_finish and
  // public_work_my_review reuse the HTTP claim and review authority".
  // server/mcp-public-work.mjs calls the same store methods as the routes.
  { tool: "public_work_recommend", method: "POST", path: "/api/public-work/match" },
  { tool: "public_work_read_task", method: "GET", path: "/api/public-work/tasks/{taskId}" },
  { tool: "public_work_claim", method: "POST", path: "/api/public-work/tasks/{taskId}/claim" },
  { tool: "public_work_renew", method: "POST", path: "/api/public-work/tasks/{taskId}/renew" },
  { tool: "public_work_release", method: "POST", path: "/api/public-work/tasks/{taskId}/release" },
  { tool: "public_work_finish", method: "POST", path: "/api/public-work/tasks/{taskId}/finish" },
  { tool: "public_work_my_review", method: "GET", path: "/api/public-work/receipts/{receiptId}/review" },
  // docs/openapi.yaml, POST /mcp description: "room_needs_me is also GET
  // /api/needs-me". The /api/needs-me description returns the favour:
  // "Same read as MCP room_needs_me."
  { tool: "room_needs_me", method: "GET", path: "/api/needs-me" },
];

// ---------------------------------------------------------------------------
// Documented allowances
// ---------------------------------------------------------------------------
//
// The two surfaces are not byte-identical by design. Each allowance pins the
// CURRENT state on both sides with the justification quote, so a change on
// either side fails the gate and forces re-triage instead of silently
// passing.
//
// fixed: the tool hardcodes the param (it is not exposed). The API must
//   still declare it; when the API declares an enum the fixed value must be
//   a member of it.
// transportOnly: MCP-transport params with no REST counterpart by design
//   (command receipt keys). The tool must have it; the API must not.
// narrowed: API params the tool deliberately does not expose (the tool is a
//   scoped subset of the route). The tool must lack it; the API must have it.
// routeSelector: an optional tool param that selects between the mapped
//   routes (required on exactly one of them). Required-ness is not compared.
// toolDefaults: API-required params the tool leaves optional because the
//   tool description documents a server-side default. Both sides are pinned.
// stricter: the tool requires what the API leaves optional, deliberately.
//   Both sides are pinned.
// wireTyped: the MCP arg is JSON (untyped on purpose); the REST query param
//   is the string wire encoding of the same logical value. Types are not
//   compared; the logical agreement is pinned by the quote.
const ALLOW = {
  bond_list: {
    transportOnly: {
      id: "MCP command-receipt key: 'omit it for a normal read, or pass a stable id to retry the same receipt'. No REST counterpart by design.",
    },
  },
  room_list_peer_dms: {
    routeSelector: {
      threadId: "'or reads one when threadId is set' — omitted lists threads (GET /api/rooms/{roomId}/peer-dms), set reads one (GET …/peer-dms/{threadId}, where it is required).",
    },
  },
  wake_register: {
    // "Same store call as POST /api/agent-heartbeats with mode wakeable."
    fixed: { mode: "wakeable" },
    stricter: {
      wakeUrl: "Tool: 'hostId and wakeUrl are required.' API: 'optional for wakeable hosts (must be https)'. Deliberate: a wakeable host with no URL cannot be woken over MCP; the REST route also serves poll-only hosts.",
    },
  },
  wake_clear: {
    // "Same store call as POST /api/agent-heartbeats with { hostId, mode: \"pull-only\" }."
    fixed: { mode: "pull-only" },
    narrowed: {
      // "Cadence is cleared because this body omits cadenceSeconds, matching that route."
      wakeUrl: "Clearing the wake URL is the point of the tool; the fixed mode pull-only forbids it route-side.",
      cadenceSeconds: "'Cadence is cleared because this body omits cadenceSeconds, matching that route.'",
      pushNotification: "'An existing push subscription row is left in place' — the tool never sends one.",
    },
  },
  wake_pause: {
    // "Same call as POST /api/rooms/:roomId/agent-pause with action pause."
    fixed: { action: "pause" },
    toolDefaults: {
      // "memberId defaults to this identity's own member."
      memberId: "tool optional, API required",
      // "requestId is the receipt key and is optional: the server mints one when it is omitted"
      requestId: "tool optional, API required",
    },
  },
  wake_resume: {
    // "Same call as POST /api/rooms/:roomId/agent-pause with action resume."
    fixed: { action: "resume" },
    toolDefaults: {
      // "memberId defaults to this identity."
      memberId: "tool optional, API required",
      // "requestId is optional and is minted by the server when omitted."
      requestId: "tool optional, API required",
    },
  },
  public_work_recommend: {
    // server/mcp-public-work.mjs: match(secret, { ...args, autoClaim: false })
    fixed: { autoClaim: false },
    narrowed: {
      // requestId/leaseHours only matter on the autoClaim write path
      // (public_work_claim is the explicit-claim tool).
      requestId: "idempotency key for the autoClaim write path, which this read-only tool never takes.",
      leaseHours: "claim-duration input for the autoClaim write path only.",
      // "Recommend available volunteer tasks." — the tool is the
      // volunteer-scoped subset; the API default is reward=volunteer and a
      // non-volunteer reward returns empty recommendations server-side.
      reward: "the tool is the volunteer-scoped subset of the route.",
    },
  },
  room_needs_me: {
    wireTyped: {
      since: "Tool: 'Complete returned cursor, unchanged. Legacy sequence numbers also accepted.' (untyped: the cursor is a JSON object, the legacy form a number). REST: the query-string wire encoding of the same logical value; the route description documents both forms ('since is a sequence number or the previous complete returned cursor object').",
    },
  },
};

// Triaged drift: real disagreements filed as GitHub issues. Each entry pins
// the CURRENT drift signature (API has the param, the tool lacks it); when
// the drift is fixed this test fails and the entry must be removed, which
// returns the param to the strict comparison.
const KNOWN_DRIFT = [
]; // empty: no triaged drift currently open

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const TOOLS = new Map();
for (const t of [...hostedMcpToolDefs, ...publicWorkMcpDefinitions]) TOOLS.set(t.name, t);

function toolParams(tool) {
  const props = tool.inputSchema?.properties || {};
  const required = new Set(tool.inputSchema?.required || []);
  return { props, required };
}

function buildMapping() {
  const mapping = new Map(); // tool name -> [{ method, path }]
  for (const tool of TOOLS.values()) {
    const claims = routeClaims(tool.description || "");
    if (claims.length) mapping.set(tool.name, claims);
  }
  for (const { tool, method, path } of SUPPLEMENT) {
    if (!TOOLS.has(tool)) throw new Error(`SUPPLEMENT names unknown tool ${tool}`);
    mapping.set(tool, [...(mapping.get(tool) || []), { method, path }]);
  }
  return mapping;
}

// Returns a list of human-readable mismatch strings for one tool.
function compareTool(toolName, routes) {
  const tool = TOOLS.get(toolName);
  const { props, required } = toolParams(tool);
  const allow = ALLOW[toolName] || {};
  const mismatches = [];

  // Union of the mapped operations' request params (room_list_peer_dms
  // legitimately spans two routes).
  const apiParams = new Map();
  for (const { method, path } of routes) {
    const found = findOperation(method, path);
    if (!found) {
      mismatches.push(`no OpenAPI operation for ${method} ${path}`);
      continue;
    }
    for (const [name, p] of effectiveRequestParams(found)) {
      const prev = apiParams.get(name);
      if (prev && (prev.required !== p.required || prev.type !== p.type || prev.location !== p.location)) {
        // Same param spelled differently across the spanned routes (e.g.
        // threadId path-required on the read-one route only) — keep the
        // most permissive view; routeSelector handles the rest.
        if (!(allow.routeSelector || {})[name]) {
          mismatches.push(`API param ${name} differs between spanned routes (${prev.location}/${prev.type} vs ${p.location}/${p.type})`);
        }
      }
      if (!prev) apiParams.set(name, p);
    }
  }

  const knownForTool = KNOWN_DRIFT.filter(k => k.tool === toolName);
  const isKnown = name => knownForTool.some(k => k.param === name);

  const check = (cond, msg) => { if (!cond) mismatches.push(msg); };

  for (const name of Object.keys(props)) {
    if (isKnown(name)) continue;
    if (allow.transportOnly?.[name]) {
      check(!apiParams.has(name), `transportOnly param ${name} now exists on the API side — re-triage`);
      continue;
    }
    const api = apiParams.get(name);
    check(api, `tool param ${name} has no OpenAPI counterpart`);
    if (!api) continue;
    const apiType = api.type, toolType = normType(props[name]?.type ?? props[name]?.anyOf?.map(x => x?.type));
    if (allow.wireTyped?.[name]) {
      check(toolType === null, `wireTyped param ${name}: tool is now concretely typed (${toolType}) — re-triage`);
      continue;
    }
    check(toolType === apiType, `type drift on ${name}: tool=${toolType ?? "untyped"} api=${apiType ?? "untyped"}`);
    if (allow.routeSelector?.[name]) continue;
    if (allow.toolDefaults?.[name]) {
      check(!required.has(name) && api.required, `toolDefaults param ${name}: expected tool-optional/API-required, got tool-required=${required.has(name)} API-required=${api.required} — re-triage`);
      continue;
    }
    if (allow.stricter?.[name]) {
      check(required.has(name) && !api.required, `stricter param ${name}: expected tool-required/API-optional, got tool-required=${required.has(name)} API-required=${api.required} — re-triage`);
      continue;
    }
    check(required.has(name) === api.required,
      `required drift on ${name}: tool=${required.has(name)} api=${api.required}`);
  }

  for (const [name, api] of apiParams) {
    if (isKnown(name)) continue;
    if (Object.hasOwn(allow.fixed || {}, name)) {
      check(!(name in props), `fixed param ${name} is now exposed by the tool — re-triage`);
      const enumVals = api.enum;
      if (enumVals) check(enumVals.includes(allow.fixed[name]), `fixed ${name}=${JSON.stringify(allow.fixed[name])} not in API enum ${JSON.stringify(enumVals)}`);
      continue;
    }
    if (allow.narrowed?.[name]) {
      check(!(name in props), `narrowed param ${name} is now exposed by the tool — re-triage`);
      continue;
    }
    if (allow.routeSelector?.[name] || allow.toolDefaults?.[name] || allow.wireTyped?.[name]) continue;
    check(name in props, `API param ${name} (${api.location}, required=${api.required}) has no tool counterpart`);
  }
  return mismatches;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("every 'Same … as' route claim resolves to a documented OpenAPI operation", () => {
  const mapping = buildMapping();
  const unresolved = [];
  for (const [toolName, routes] of mapping) {
    for (const { method, path } of routes) {
      if (!findOperation(method, path)) unresolved.push(`${toolName}: ${method} ${path}`);
    }
  }
  assert.deepEqual(unresolved, [], "route claims with no OpenAPI operation");
  // The gate must not silently shrink: a parser regression that drops
  // mappings must fail loudly.
  assert.ok(mapping.size >= 20, `only ${mapping.size} tools mapped; expected >= 20`);
});

test("known drift entries still describe reality", () => {
  const problems = [];
  for (const { tool, param, issue } of KNOWN_DRIFT) {
    const t = TOOLS.get(tool);
    if (!t) { problems.push(`${tool}: tool no longer exists — remove the KNOWN_DRIFT entry (${issue})`); continue; }
    const { props } = toolParams(t);
    const mapping = buildMapping().get(tool) || [];
    const apiParams = new Map();
    for (const { method, path } of mapping) {
      const found = findOperation(method, path);
      if (found) for (const [name, p] of effectiveRequestParams(found)) apiParams.set(name, p);
    }
    if (param in props) problems.push(`${tool}.${param}: the tool now exposes it — drift fixed, remove the KNOWN_DRIFT entry (${issue})`);
    else if (!apiParams.has(param)) problems.push(`${tool}.${param}: the API no longer declares it — re-triage the KNOWN_DRIFT entry (${issue})`);
    // else: drift still present exactly as triaged — the entry stands and
    // the strict comparison skips this param.
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("MCP tool request shapes agree with their OpenAPI operations", () => {
  const mapping = buildMapping();
  const failures = [];
  for (const [toolName, routes] of mapping) {
    const mismatches = compareTool(toolName, routes);
    for (const m of mismatches) failures.push(`${toolName}: ${m}`);
  }
  assert.deepEqual(failures, [], "MCP/OpenAPI request-shape drift");
});

test("registry surface sanity: the compared tools are the documented MCP catalog", () => {
  // Guards against the test drifting off the real registry (e.g. a rename
  // of the exported tool arrays that silently empties TOOLS).
  assert.ok(TOOLS.size >= 90, `TOOLS has ${TOOLS.size} entries; expected the full MCP catalog (>= 90)`);
  assert.ok(hostedRoomTools.length >= 20, `hostedRoomTools has ${hostedRoomTools.length} entries`);
  assert.ok(publicWorkMcpDefinitions.length >= 7, `publicWorkMcpDefinitions has ${publicWorkMcpDefinitions.length} entries`);
});
