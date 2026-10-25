// FIX12-9: a tools/list description, including the full-profile contract
// line, stays within 400 characters. Longer notes live in tool-notes.
import test from "node:test";
import assert from "node:assert/strict";
import { listedMcpTools, livePublicMcpTools, MCP_TOOL_FOCUSES } from "../server/mcp-discovery.mjs";

const CAP = 400;

function overCap(label, tools) {
  return tools
    .filter(tool => (tool.description || "").length > CAP)
    .map(tool => `${label} ${tool.name} ${(tool.description || "").length}`);
}

test("served MCP tool descriptions stay within 400 characters", () => {
  const lists = [
    ["public", livePublicMcpTools()],
    ["full", listedMcpTools("full")],
    ["core", listedMcpTools("core")],
    ["lean", listedMcpTools("lean")],
    ...Object.keys(MCP_TOOL_FOCUSES).map(focus => [focus, listedMcpTools("core", false, null, focus)]),
  ];
  assert.deepEqual(lists.flatMap(([label, tools]) => overCap(label, tools)), []);
});
