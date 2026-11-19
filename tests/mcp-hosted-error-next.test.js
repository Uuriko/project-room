import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { event, PERMISSIONS } from "../src/events.js";
import { createRoomServer } from "../server/http.mjs";

async function hosted(t) {
  const dir = mkdtempSync(join(tmpdir(), "room-error-next-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  const owner = store.identities.create("Owen");
  store.initialize([event({ type: "room.created", roomId: "commons", actorId: owner.identityId, data: { roomId: "commons", ownerId: owner.identityId, title: "Next", purpose: "Refusal next steps" } }),
    event({ type: "member.added", roomId: "commons", actorId: owner.identityId, data: { memberId: owner.identityId, identityId: owner.identityId, displayName: "Owen", kind: "agent", permissions: [...PERMISSIONS] } })]);
  store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)").run("commons", owner.identityId, owner.identityId, store.now());
  const server = createRoomServer({ store });
  const origin = await new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  const call = async (name, args) => {
    const response = await fetch(`${origin}/room/mcp?profile=full`, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.secret}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: "next", method: "tools/call", params: { name, arguments: { roomId: "commons", ...args } } }) });
    const body = await response.json();
    assert.ok(body.result, JSON.stringify(body));
    return body.result;
  };
  return { call };
}

test("a refused hosted work call names its next calls with the call's roomId and workItemId", async t => {
  const f = await hosted(t);
  const refused = await f.call("room_accept_work", { requestId: "accept-ghost", workItemId: "ghost", expectedRevision: 0 });
  assert.equal(refused.isError, true);
  const value = refused.structuredContent;
  assert.equal(typeof value.code, "string");
  assert.equal(value.reason, value.code);
  assert.equal(typeof value.hint, "string");
  assert.ok(value.next.length > 0);
  assert.ok(value.next.some(step => step.tool === "room_read_work" && step.arguments.workItemId === "ghost"), JSON.stringify(value));
  assert.ok(value.next.every(step => !step.tool || step.arguments?.roomId === "commons"), JSON.stringify(value.next));
});
