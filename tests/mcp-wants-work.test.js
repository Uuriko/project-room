// W-34: wants_work_get/set/clear are the MCP twin of
// GET/PUT/DELETE /api/rooms/{roomId}/members/me/wants-work (BOARD-WAKE-2).
// The signal was HTTP-only, so an agent on hosted MCP had to leave the
// transport and hand-roll HTTP to declare it wants work. These tests call
// the real hosted MCP door and pin: set/get/clear round-trip on the
// caller's own row, the row lands in the same store the HTTP route reads,
// and an invalid filter is a 422 invalid_request, not a silent write.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { readWantsWork } from "../server/work-wants.mjs";

function serve(t) {
  const d = mkdtempSync(join(tmpdir(), "mcp-wants-work-"));
  const store = new RoomStore(join(d, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const s = createRoomServer({ store });
  return new Promise(res => s.listen(0, "127.0.0.1", () => {
    t.after(async () => { s.closeStreams(); s.closeAllConnections(); await new Promise(r => s.close(r)); store.close(); rmSync(d, { recursive: true, force: true }); });
    res({ o: `http://127.0.0.1:${s.address().port}`, store, rooms });
  }));
}

async function mcp(o, name, args, secret) {
  const r = await fetch(`${o}/room/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "tools/call", params: { name, arguments: args } }) });
  const body = await r.json();
  return body.result?.structuredContent ?? body.error ?? body.result;
}

async function setup(t) {
  const { o, store, rooms } = await serve(t);
  const owner = store.identities.create("Wren");
  rooms.create(owner.secret, { roomId: "want-den", title: "W", purpose: "p", kind: "personal", displayName: "Wren" });
  const peer = store.identities.create("Lark");
  const linked = store.identities.link(owner.secret, "want-den", { identityId: peer.identityId, displayName: "Lark", permissions: [] });
  return { o, store, peer, memberId: linked.memberId ?? linked.id };
}

test("wants_work trio round-trips the caller's own row over MCP", async t => {
  const { o, store, peer, memberId } = await setup(t);
  const off = await mcp(o, "wants_work_get", { roomId: "want-den" }, peer.secret);
  assert.equal(off.wantsWork, null, "default off");
  const set = await mcp(o, "wants_work_set", { roomId: "want-den", labels: ["Docs"], capabilities: ["work"] }, peer.secret);
  assert.deepEqual(set.wantsWork, { labels: ["docs"], capabilities: ["work"] }, "labels normalize to lowercase like HTTP");
  assert.equal(set.memberId, memberId);
  // The MCP write lands in the same store the HTTP route reads.
  assert.deepEqual(readWantsWork(store.db, "want-den", memberId).wantsWork, { labels: ["docs"], capabilities: ["work"] });
  const got = await mcp(o, "wants_work_get", { roomId: "want-den" }, peer.secret);
  assert.deepEqual(got.wantsWork, { labels: ["docs"], capabilities: ["work"] });
  const cleared = await mcp(o, "wants_work_clear", { roomId: "want-den" }, peer.secret);
  assert.equal(cleared.wantsWork, null);
  assert.equal(readWantsWork(store.db, "want-den", memberId).wantsWork, null);
});

test("wants_work_set refuses an invalid capability with 422 invalid_request", async t => {
  const { o, store, peer, memberId } = await setup(t);
  const out = await mcp(o, "wants_work_set", { roomId: "want-den", capabilities: ["fly"] }, peer.secret);
  const text = JSON.stringify(out);
  assert.match(text, /invalid_request/, text);
  assert.equal(readWantsWork(store.db, "want-den", memberId).wantsWork, null, "nothing was written");
});
