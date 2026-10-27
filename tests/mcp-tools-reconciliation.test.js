// QA2-CONTRACT MCP tools-list reconciliation (2026-10-04).
//
// Round 1 found public_work_recommend and room_list_work missing from the
// default profile's tools/list while /.well-known/ard.json lists them. The
// default-catalog flip (2026-10-27) changed that scoping on purpose:
// public_work_recommend now ships in the lean default, room_list_work is
// reached through the listed discovery pair, and the server card's enrolled
// list is the member default catalog (#3769). This test pins the
// reconciliation contract at the real boundary:
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
import { aiCatalog } from "../server/agent-discovery.mjs";
import { listedMcpTools, livePublicMcpTools, liveEnrolledMcpTools } from "../server/mcp-discovery.mjs";
import { hostedMcpToolDefs } from "../server/mcp-hosted-tools.mjs";
import { actionMetaToolDefs } from "../server/mcp-action-search.mjs";
import { MCP_JOIN_TOOLS } from "../server/mcp-http.mjs";
import { publicWorkMcpDefinitions, anonymousPublicWorkMcpTools } from "../server/mcp-public-work.mjs";
import { identityMintMcpDefinitions } from "../server/mcp-identity-mint.mjs";

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
    "lean (default)": listedMcpTools("lean"),
    core: listedMcpTools("core"),
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
    ...actionMetaToolDefs.map(t => t.name),
    ...MCP_JOIN_TOOLS.map(t => t.name),
    ...publicWorkMcpDefinitions.map(t => t.name),
    ...identityMintMcpDefinitions.map(t => t.name),
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

test("round-1 scoping, as flipped 2026-10-27: the default is lean, public_work is in it, room_list_work is reached via search/run", () => {
  const profiles = servedProfiles();
  const names = list => list.map(t => t.name);
  // The default lean profile is intentionally the short catalog. Since the
  // flip it carries the public-work set (membership must not remove it),
  // while room_list_work stays out of the direct list and is reached
  // through the listed room_search_actions / room_run_action pair.
  assert.ok(names(profiles["lean (default)"]).includes("public_work_recommend"), "public_work_recommend is in the default profile since the flip");
  assert.ok(!names(profiles["lean (default)"]).includes("room_list_work"), "room_list_work is not directly in the default profile");
  assert.ok(names(profiles["lean (default)"]).includes("room_search_actions"), "the default lists the discovery hatch for room_list_work");
  assert.ok(!names(profiles.core).includes("public_work_recommend"), "public_work_recommend is not in the explicit core profile");
  assert.ok(names(profiles["focus=public_work"]).includes("public_work_recommend"), "public_work_recommend is in focus=public_work");
  assert.ok(names(profiles["focus=work"]).includes("room_list_work"), "room_list_work is in focus=work");
  // The enrolled server-card list is the member default catalog (#3769):
  // the lean front door plus the public-work set, not the non-member list
  // alone (which has no room front door).
  assert.ok(names(profiles.enrolled).includes("room_post_message"), "enrolled server-card list is the member catalog (hosted room tools)");
  assert.ok(names(profiles.enrolled).includes("public_work_recommend"), "enrolled server-card list keeps the public-work set since the flip");
  assert.ok(names(profiles.enrolled).includes("room_search_actions"), "enrolled server-card list carries the discovery hatch");
  assert.ok(names(profiles.full).includes("public_work_recommend"), "public_work_recommend is in profile=full");
});
