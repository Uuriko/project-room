// QA5-gb-AX-3 and QA5-gb-AX-2: "Did you mean" only for near misses, and the two
// anonymous public-work tools document every parameter.
import test from "node:test";
import assert from "node:assert/strict";
import { closestToolName, mcpCallError } from "../server/mcp-arg-errors.mjs";
import { handleMcpJoinRpc } from "../server/mcp-http.mjs";
import { anonymousPublicWorkMcpTools } from "../server/mcp-public-work.mjs";

const TOOLS = ["room_post_message", "room_read_messages", "room_block_work", "room_needs_me", "bond_accept", "room_join_packet"];

test("closestToolName suggests typos and partial names, never an unrelated tool", () => {
  assert.equal(closestToolName("room_post_mesage", TOOLS), "room_post_message");
  assert.equal(closestToolName("room_read_message", TOOLS), "room_read_messages");
  assert.equal(closestToolName("post_message", TOOLS), "room_post_message");
  assert.equal(closestToolName("room_needsme", TOOLS), "room_needs_me");
  assert.equal(closestToolName("qa5_no_such_tool", TOOLS), null, "no shared name, no suggestion");
  assert.equal(closestToolName("room_close_work", TOOLS), null, "a different state change is not a typo");
  assert.equal(closestToolName("", TOOLS), null);
  assert.equal(closestToolName(undefined, TOOLS), null);
  assert.equal(closestToolName("ab", ["ac"]), null, "very short names need an exact or contained match");
});

test("an unknown tool with no near miss says so instead of guessing", () => {
  const error = mcpCallError(1, { reason: "unknown_tool", tool: "qa5_no_such_tool", suggestion: closestToolName("qa5_no_such_tool", TOOLS) });
  assert.equal(error.error.data.suggestion, null);
  assert.doesNotMatch(error.error.data.hint, /Did you mean/);
  assert.match(error.error.data.hint, /tools\/list/);
  const anon = handleMcpJoinRpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "qa5_no_such_tool", arguments: {} } });
  assert.equal(anon.error.message, "unknown_tool");
  assert.equal(anon.error.data.suggestion, null);
  const typo = handleMcpJoinRpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "room_join_pakcet", arguments: {} } });
  assert.equal(typo.error.data.suggestion, "room_join_packet");
});

test("anonymous public-work tools describe every parameter", () => {
  assert.equal(anonymousPublicWorkMcpTools.length, 2);
  for (const tool of anonymousPublicWorkMcpTools) {
    const properties = tool.inputSchema.properties;
    assert.ok(Object.keys(properties).length > 0, tool.name);
    for (const [name, schema] of Object.entries(properties)) {
      assert.equal(typeof schema.description, "string", `${tool.name}.${name} has a description`);
      assert.ok(schema.description.length >= 20, `${tool.name}.${name} description says something`);
    }
  }
});
