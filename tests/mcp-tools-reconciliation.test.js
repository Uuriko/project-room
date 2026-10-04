// QA2-CONTRACT MCP tools-list reconciliation (2026-10-04).
//
// Round 1 found public_work_recommend and room_list_work missing from the
// default profile's tools/list while /.well-known/ard.json lists them. The
// scoping is intentional (they live under focus=public_work / focus=work and
// profile=full, and the server card uses the enrolled list) - but nothing
// pinned it, so the next catalog edit could silently strand a tool. This test
// pins the reconciliation contract at the real boundary:
//
//   1. every MCP tool named in the ARD ai-catalog
//      (/.well-known/ard.json, the normative agent discovery document)
//      appears in SOME served profile's tools/list, and
//   2. every tool any served profile lists exists in code (has a handler
//      definition) - no phantom tools advertised to agents.
//
// It imports the same functions that serve the real responses (aiCatalog,
// listedMcpTools, livePublicMcpTools, liveEnrolledMcpTools), so a rename in
// any of the three places (catalog, profile, handler) fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { aiCatalog } from "../deploy/agent-discovery.mjs";
import { listedMcpTools, livePublicMcpTools, liveEnrolledMcpTools } from "../server/mcp-discovery.mjs";
import { hostedMcpToolDefs } from "../server/mcp-hosted-tools.mjs";
import { MCP_JOIN_TOOLS } from "../server/mcp-http.mjs";
import { publicWorkMcpDefinitions, anonymousPublicWorkMcpTools } from "../server/mcp-public-work.mjs";

function ardMcpTools() {
  const catalog = JSON.parse(aiCatalog());
  assert.equal(catalog.specVersion, "0.91", "ARD spec version pinned by the catalog");
  const entry = catalog.entries.find(e => e.type === "application/mcp-server-card+json");
  assert.ok(entry, "ARD catalog has an MCP server entry");
  assert.ok(Array.isArray(entry.capabilities) && entry.capabilities.length > 0, "MCP entry names capabilities");
  return entry.capabilities;
}

// Every tools/list shape the server actually serves, keyed by profile name.
function servedProfiles() {
  return {
    public: livePublicMcpTools(),
    "core (default)": listedMcpTools("core"),
    full: listedMcpTools("full"),
    "focus=work": listedMcpTools("core", false, null, "work"),
    "focus=conversation": listedMcpTools("core", false, null, "conversation"),
    "focus=review": listedMcpTools("core", false, null, "review"),
    "focus=automation": listedMcpTools("core", false, null, "automation"),
    "focus=public_work": listedMcpTools("core", false, null, "public_work"),
    enrolled: liveEnrolledMcpTools(),
  };
}

// Every tool name the server can actually execute: the handler definition
// lists behind tools/list and tools/call.
function codeToolNames() {
  return new Set([
    ...hostedMcpToolDefs.map(t => t.name),
    ...MCP_JOIN_TOOLS.map(t => t.name),
    ...publicWorkMcpDefinitions.map(t => t.name),
    ...(anonymousPublicWorkMcpTools ?? []).map(t => t.name),
  ]);
}

test("every ARD-catalog MCP tool appears in some served tools/list profile", () => {
  const ardTools = ardMcpTools();
  const profiles = servedProfiles();
  for (const tool of ardTools) {
    const where = Object.entries(profiles)
      .filter(([, tools]) => tools.some(t => t.name === tool))
      .map(([name]) => name);
    assert.ok(where.length > 0,
      `ARD catalog advertises MCP tool ${tool} but no served tools/list profile includes it`);
  }
});

test("every served MCP tool exists in code", () => {
  const profiles = servedProfiles();
  const code = codeToolNames();
  assert.ok(code.size > 50, "handler definition set is real");
  for (const [profile, tools] of Object.entries(profiles)) {
    assert.ok(tools.length > 0, `${profile} profile lists tools`);
    for (const tool of tools) {
      assert.ok(typeof tool.name === "string" && tool.name.length > 0, `${profile}: tool has a name`);
      assert.ok(code.has(tool.name),
        `${profile} profile lists ${tool.name} but no handler definition exists in code`);
    }
  }
});

test("round-1 scoping is pinned: public_work_recommend and room_list_work live outside the default profile", () => {
  const profiles = servedProfiles();
  const names = list => list.map(t => t.name);
  // The default core profile is intentionally the short catalog; these two
  // are discovered via focus profiles and the enrolled server card.
  assert.ok(!names(profiles["core (default)"]).includes("public_work_recommend"), "public_work_recommend is not in the default profile");
  assert.ok(!names(profiles["core (default)"]).includes("room_list_work"), "room_list_work is not in the default profile");
  assert.ok(names(profiles["focus=public_work"]).includes("public_work_recommend"), "public_work_recommend is in focus=public_work");
  assert.ok(names(profiles["focus=work"]).includes("room_list_work"), "room_list_work is in focus=work");
  assert.ok(names(profiles.enrolled).includes("public_work_recommend"), "enrolled server-card list includes public_work_recommend");
});
