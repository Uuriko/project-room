import test from "node:test";
import assert from "node:assert/strict";
import { listedMcpTools, DEFAULT_MCP_PROFILE, liveEnrolledMcpTools } from "../server/mcp-discovery.mjs";
import { LEAN_MCP_TOOLS } from "../server/mcp-action-search.mjs";
import { countAliasCall, aliasCallCounts, resetAliasCallCounts } from "../server/mcp-alias-usage.mjs";
import { canonicalMcpToolName } from "../src/room-mcp-join.js";

test("default tools/list profile is lean with room_search_actions", () => {
  assert.equal(DEFAULT_MCP_PROFILE, "lean");
  const names = listedMcpTools().map(tool => tool.name);
  for (const name of LEAN_MCP_TOOLS) assert.ok(names.includes(name), name);
  assert.ok(names.includes("room_search_actions"));
  assert.ok(LEAN_MCP_TOOLS.length <= 12);
  assert.deepEqual(liveEnrolledMcpTools().map(t => t.name), names);
});

test("core profile is still selectable", () => {
  assert.ok(listedMcpTools("core").length > listedMcpTools("lean").length - 3);
});

test("legacy aliases still resolve and are counted", () => {
  resetAliasCallCounts();
  assert.equal(canonicalMcpToolName("wake.pause"), "wake_pause");
  const log = console.log; console.log = () => {};
  try { countAliasCall("wake.pause"); countAliasCall("wake.pause"); } finally { console.log = log; }
  assert.deepEqual(aliasCallCounts(), { "wake.pause": 2 });
});
