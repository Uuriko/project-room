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

// The authenticated HTTP path selects the Room profile before diagnosing a
// typo, so the anonymous helper above cannot catch a missing suggestion there.
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

async function signedInCaller(t) {
  const store = new RoomStore(":memory:");
  const identity = store.identities.create("Suggestion caller");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  return async name => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${identity.secret}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: "suggestion", method: "tools/call", params: { name, arguments: {} } }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
}

test("signed-in public-work typos suggest the same tools as anonymous calls", async t => {
  const signedIn = await signedInCaller(t);
  for (const [typo, expected] of [
    ["public_work_recomend", "public_work_recommend"],
    ["public_work_read_tsk", "public_work_read_task"],
    ["public_work_clam", "public_work_claim"],
  ]) {
    await t.test(typo, async () => {
      const response = await signedIn(typo);
      assert.equal(response.error.message, "unknown_tool");
      assert.equal(response.error.data.suggestion, expected);
      assert.match(response.error.data.hint, new RegExp(`Did you mean "${expected}"`));
    });
  }
});

test("signed-in suggestion controls preserve unrelated names and join-tool typos", async t => {
  const signedIn = await signedInCaller(t);
  const unrelated = await signedIn("qa5r_no_such_tool");
  assert.equal(unrelated.error.message, "unknown_tool");
  assert.equal(unrelated.error.data.suggestion, null);
  const joinTypo = await signedIn("room_join_pakcet");
  assert.equal(joinTypo.error.message, "unknown_tool");
  assert.equal(joinTypo.error.data.suggestion, "room_join_packet");
});
