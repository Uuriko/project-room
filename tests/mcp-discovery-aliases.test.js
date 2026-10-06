// Dotted tool aliases through the MCP discovery boundary (server/mcp-discovery.mjs).
//
// Contract: when a caller asks for aliases, every listed tool whose canonical
// name has a dotted legacy name advertises exactly that name in `aliases`, and
// every advertised dotted name round-trips through canonicalMcpToolName back to
// the listing tool's canonical name. Aliases are additive: nothing changes
// about names, schemas, or descriptions, and no dotted name collides with a
// canonical tool name. Aliases stay hidden unless explicitly requested.
// Regression risk: a swapped/shifted alias map or a colliding new alias would
// advertise dotted names that do not resolve, which the HTTP-level tests in
// tests/mcp-core-profile.test.js do not cover at this boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { listedMcpTools, livePublicMcpTools, liveEnrolledMcpTools } from "../server/mcp-discovery.mjs";
import { MCP_TOOL_ALIASES, canonicalMcpToolName } from "../src/room-mcp-join.js";

function listed(profile, aliases, focus) {
  return listedMcpTools(profile, aliases, null, focus);
}

test("aliases=true: every advertised dotted alias resolves to its listed canonical tool", () => {
  const tools = listed("full", true);
  const aliased = tools.filter(tool => tool.aliases !== undefined);
  assert.ok(aliased.length > 0, "full listing should advertise some aliases");
  for (const tool of aliased) {
    assert.deepEqual(tool.aliases.length, 1, `${tool.name}: exactly one alias`);
    assert.equal(canonicalMcpToolName(tool.aliases[0]), tool.name,
      `${tool.aliases[0]} must resolve to ${tool.name}`);
  }
});

test("full catalog advertises every registry alias exactly once, on the right tool", () => {
  const tools = listed("full", true);
  const seen = new Map();
  for (const tool of tools) {
    for (const alias of tool.aliases ?? []) {
      assert.ok(!seen.has(alias), `alias ${alias} advertised twice`);
      seen.set(alias, tool.name);
    }
  }
  for (const [alias, canonical] of Object.entries(MCP_TOOL_ALIASES)) {
    assert.equal(seen.get(alias), canonical, `${alias} must be advertised on ${canonical}`);
  }
  assert.equal(seen.size, Object.keys(MCP_TOOL_ALIASES).length);
});

test("no dotted alias collides with any canonical tool name in the listing", () => {
  const tools = listed("full", true);
  const canonical = new Set(tools.map(tool => tool.name));
  for (const tool of tools) {
    for (const alias of tool.aliases ?? []) {
      assert.ok(!canonical.has(alias), `${alias} collides with a canonical tool name`);
    }
  }
});

test("aliases are additive: same tools, same schemas as the aliases=false listing", () => {
  const plain = listed("full", false);
  const aliased = listed("full", true);
  assert.deepEqual(aliased.map(tool => tool.name), plain.map(tool => tool.name),
    "tool order and membership must not change");
  for (let i = 0; i < plain.length; i++) {
    assert.deepEqual(aliased[i].inputSchema, plain[i].inputSchema, `${plain[i].name}: schema unchanged`);
    assert.equal(aliased[i].description, plain[i].description, `${plain[i].name}: description unchanged`);
  }
  // Tools with no registry alias carry no aliases key at all (never an empty array).
  for (const tool of aliased) {
    if (!(tool.name in Object.fromEntries(Object.entries(MCP_TOOL_ALIASES).map(([a, c]) => [c, a])))) {
      assert.ok(!("aliases" in tool), `${tool.name} must not carry an aliases key`);
    }
  }
});

test("aliases stay hidden unless requested: core listing and public surfaces", () => {
  assert.ok(listed("core", false).every(tool => !("aliases" in tool)), "core, aliases=false: hidden");
  assert.ok(livePublicMcpTools().every(tool => !("aliases" in tool)), "public server-card tools: never advertised");
  assert.ok(liveEnrolledMcpTools().every(tool => !("aliases" in tool)), "enrolled public tools: never advertised");
});

test("aliases flag ignored safely on the public-work outside branch", () => {
  // The outside branch returns join tools + public-work definitions, none of
  // which have dotted aliases; the flag must not invent any.
  const tools = listed("core", true, "public_work");
  assert.ok(tools.length > 0);
  assert.ok(tools.every(tool => !("aliases" in tool)), "outside branch carries no aliases");
});
