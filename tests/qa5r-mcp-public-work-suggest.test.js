// QA5R-AX-1: a near-miss of a public-work tool name on the anonymous MCP path
// suggests the public-work tool instead of returning no suggestion.
// AX-1B: signed-in hosted profile suggests public-work tools the same way.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMcpJoinRpc } from "../server/mcp-http.mjs";
import { PUBLIC_WORK_MCP_TOOLS } from "../src/room-mcp-join.js";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";

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

function setupSignedIn(t) {
  const directory = mkdtempSync(join(tmpdir(), "qa5r-ax1b-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const identity = store.identities.create("AX1B agent");
  const mcp = createHostedRoomMcp(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { mcp, secret: identity.secret };
}

test("signed-in typos of public-work tools suggest the public-work tool", async t => {
  const { mcp, secret } = setupSignedIn(t);
  for (const [typo, expected] of [
    ["public_work_recomend", "public_work_recommend"],
    ["public_work_read_tsk", "public_work_read_task"],
    ["public_work_clam", "public_work_claim"],
  ]) {
    const response = await mcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: typo, arguments: {} } },
      { authorization: `Bearer ${secret}` },
    );
    assert.equal(response.error.message, "unknown_tool", typo);
    assert.equal(response.error.data.suggestion, expected, typo);
    assert.match(response.error.data.hint, new RegExp(`Did you mean "${expected}"`), typo);
  }
});

test("signed-in unrelated names still get no suggestion", async t => {
  const { mcp, secret } = setupSignedIn(t);
  const response = await mcp(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "qa5r_no_such_tool", arguments: {} } },
    { authorization: `Bearer ${secret}` },
  );
  assert.equal(response.error.message, "unknown_tool");
  assert.equal(response.error.data.suggestion, null);
});
