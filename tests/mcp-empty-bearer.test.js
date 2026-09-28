// An MCP host config such as the Claude Code plugin sends
// `Authorization: Bearer ${PROJECT_ROOM_SECRET}`. Before the agent enrolls that
// variable is empty. Contract guarded: an empty Bearer gets the public join
// tools, not an auth error, and a real (even invalid) token still goes to the
// room profile.
import test from "node:test";
import assert from "node:assert/strict";
import { dispatchRoomMcp } from "../server/mcp-http.mjs";

const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };

test("empty Bearer headers fall back to the public join tools", async () => {
  for (const authorization of ["Bearer ", "Bearer", "bearer   ", "  "]) {
    let roomCalled = false;
    const reply = await dispatchRoomMcp(list, { mcpUrl: "https://room.example/mcp", authorization, roomMcp: async () => { roomCalled = true; return {}; } });
    assert.equal(roomCalled, false, JSON.stringify(authorization));
    assert.ok(Array.isArray(reply.result?.tools) && reply.result.tools.length > 0);
  }
});

test("a presented token still goes to the room profile", async () => {
  let seen = null;
  await dispatchRoomMcp(list, { mcpUrl: "https://room.example/mcp", authorization: "Bearer pri_x", roomMcp: async (_m, o) => { seen = o.authorization; return {}; } });
  assert.equal(seen, "Bearer pri_x");
});
