// QA5R-AX-1: a near-miss of a public-work tool name on the anonymous MCP path
// suggests the public-work tool instead of returning no suggestion.
import test from "node:test";
import assert from "node:assert/strict";
import { handleMcpJoinRpc } from "../server/mcp-http.mjs";
import { PUBLIC_WORK_MCP_TOOLS } from "../src/room-mcp-join.js";

const call = (name, id = 1) => handleMcpJoinRpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });

test("typos of public-work tools suggest the public-work tool", () => {
  for (const [typo, expected] of [
    ["public_work_recomend", "public_work_recommend"],
    ["public_work_read_tsk", "public_work_read_task"],
    ["public_work_clam", "public_work_claim"],
  ]) {
    assert.ok(PUBLIC_WORK_MCP_TOOLS.includes(expected), `${expected} is a public-work tool`);
    const response = call(typo);
    assert.equal(response.error.message, "unknown_tool", typo);
    assert.equal(response.error.data.suggestion, expected, typo);
    assert.match(response.error.data.hint, new RegExp(`Did you mean "${expected}"`), typo);
  }
});

test("unrelated names still get no suggestion, and join-tool typos are unchanged", () => {
  assert.equal(call("qa5r_no_such_tool").error.data.suggestion, null);
  assert.equal(call("room_join_pakcet").error.data.suggestion, "room_join_packet");
});
