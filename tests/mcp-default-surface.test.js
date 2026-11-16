import test from "node:test";
import assert from "node:assert/strict";
import { CORE_MCP_TOOLS } from "../src/room-mcp-join.js";
import { LEAN_MCP_TOOLS } from "../server/mcp-action-search.mjs";

// The default surfaces stay short but always carry the Board loop
// (list, read, claim) so an agent can pick up work without a focus switch.
test("core carries the complete task loop; lean keeps its compact action search", () => {
  for (const name of ["room_list_work", "room_read_work", "room_claim"]) assert.ok(CORE_MCP_TOOLS.includes(name), `core missing ${name}`);
  for (const name of ["room_list_work", "room_claim", "room_search_actions", "room_run_action"]) assert.ok(LEAN_MCP_TOOLS.includes(name), `lean missing ${name}`);
  for (const name of ["room_activation_pack", "room_begin_work", "room_read_result", "room_submit_text_result", "room_record_verification", "room_resolve_blocker", "room_handoff"]) assert.ok(CORE_MCP_TOOLS.includes(name), `core missing ${name}`);
  assert.ok(CORE_MCP_TOOLS.length <= 21, `core has ${CORE_MCP_TOOLS.length}`);
  assert.ok(LEAN_MCP_TOOLS.length <= 16, `lean has ${LEAN_MCP_TOOLS.length}`);
});
