// UT26 lane 10 F3 (10-3): the starter claim a room creator holds is a board
// claim in state "claimed", so it fell between the activation pack's two
// work lists — openWork (work items) and openClaims (unclaimed board rows
// only) — and was invisible in the pack and in MCP room_list_work. The pack
// now carries the viewer's own board claims as myClaims, and room_list_work
// carries them as boardClaims.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-my-claims-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, rooms };
}

async function rpc(origin, method, params, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, params })
  });
  return response.json();
}

test("activation pack surfaces the creator's claimed starter as myClaims", async t => {
  const { origin, store, rooms } = await serve(t);
  const ada = store.identities.create("Ada");
  const created = rooms.create(ada.secret, {
    roomId: "ada-den", title: "Ada den", purpose: "My claims", kind: "personal", displayName: "Ada"
  });
  assert.equal(created.starter.state, "claimed");

  const packResponse = await fetch(`${origin}/api/rooms/ada-den/activation-pack`, {
    headers: { Authorization: `Bearer ${ada.secret}` }
  });
  assert.equal(packResponse.status, 200);
  const pack = await packResponse.json();
  assert.deepEqual(pack.openClaims, [], "the starter is already held, not pick-up work");
  const mine = pack.myClaims?.find(claim => claim.id === "starter");
  assert.ok(mine, `pack.myClaims must carry the starter; got ${JSON.stringify(pack.myClaims)}`);
  assert.equal(mine.state, "claimed");
  assert.equal(mine.source, "board");
  assert.equal(mine.owner, created.ownerMemberId);
  assert.ok(mine.leaseExpiresAt, "the starter's lease is visible before it lapses");
  assert.equal(mine.untrusted, true);
  assert.equal(mine.updateAction.method, "POST");
  assert.equal(mine.updateAction.endpoint, "/api/rooms/ada-den/work-claims/starter/update");

  // The MCP door serves the same pack.
  const mcpPack = await rpc(origin, "tools/call", { name: "room_activation_pack", arguments: { roomId: "ada-den" } }, ada.secret);
  assert.ok(mcpPack.result.structuredContent.myClaims.some(claim => claim.id === "starter"));

  // A member who holds nothing sees an empty myClaims, never Ada's starter.
  const bob = store.identities.create("Bob");
  store.identities.link(ada.secret, "ada-den", { identityId: bob.identityId, displayName: "Bob", permissions: [] });
  const bobPack = await (await fetch(`${origin}/api/rooms/ada-den/activation-pack`, {
    headers: { Authorization: `Bearer ${bob.secret}` }
  })).json();
  assert.deepEqual(bobPack.myClaims, []);
});

test("MCP room_list_work surfaces the holder's board claims as boardClaims", async t => {
  const { origin, store, rooms } = await serve(t);
  const ada = store.identities.create("Ada");
  rooms.create(ada.secret, {
    roomId: "ada-den", title: "Ada den", purpose: "My claims", kind: "personal", displayName: "Ada"
  });
  const listed = await rpc(origin, "tools/call", { name: "room_list_work", arguments: { roomId: "ada-den" } }, ada.secret);
  const value = listed.result.structuredContent;
  assert.deepEqual(value.work, [], "the starter is a board claim, not a work item");
  const mine = value.boardClaims?.find(claim => claim.id === "starter");
  assert.ok(mine, `room_list_work boardClaims must carry the starter; got ${JSON.stringify(value.boardClaims)}`);
  assert.equal(mine.state, "claimed");
  assert.equal(mine.untrusted, true);
});
