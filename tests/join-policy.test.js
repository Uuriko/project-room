// Standing join policy: approve waits, auto admits, closed refuses.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function boot(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-join-policy-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({ store, ownerKey, origin: `http://127.0.0.1:${server.address().port}` });
  }));
}

async function post(origin, path, body, token) {
  const res = await fetch(origin + path, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

test("closed refuses a new pair and auto:chat admits one immediately", async t => {
  const { origin, ownerKey, store } = await boot(t);
  const closed = await post(origin, "/api/rooms/commons/join-policy", { mode: "closed" }, ownerKey);
  assert.equal(closed.status, 200);
  const refused = await post(origin, "/api/pair", { room: "commons", name: "Closed Agent" });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, "join_closed");
  const opened = await post(origin, "/api/rooms/commons/join-policy", { mode: "auto:chat" }, ownerKey);
  assert.equal(opened.json.mode, "auto:chat");
  const admitted = await post(origin, "/api/pair", { room: "commons", name: "Auto Agent" });
  assert.equal(admitted.status, 200, JSON.stringify(admitted.json));
  assert.equal(typeof admitted.json.token, "string");
  assert.equal(admitted.json.pairId, undefined);
  const member = store.room("commons").state.members[admitted.json.memberId];
  assert.equal(member.kind, "agent");
  assert.ok(!member.permissions.includes("manage_members"));
  const log = store.db.prepare("SELECT body FROM events WHERE room_id=?").all("commons").map(row => JSON.parse(row.body));
  assert.ok(log.some(event => event.type === "pair.approved" && event.data.memberId === admitted.json.memberId));
});
